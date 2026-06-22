"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePrivy } from "@privy-io/react-auth";
import type { AuthUser } from "@occa/shared/types";
import {
  ApiError,
  authApi,
  meApi,
  getStoredToken,
  setStoredToken,
} from "@/lib/api";

// Auth state machine. Strings instead of a discriminated union so that
// existing equality checks elsewhere (`status === "authenticated"`)
// keep compiling. Per-state context (error message, etc.) sits on the
// hook return alongside `status`.
//
//   booting           — initial: hydrate stored JWT + wait for Privy.
//                       Watchdog drops to `idle` after BOOT_TIMEOUT_MS so
//                       the UI never gets stuck with a hidden button.
//   idle              — no session and not in flight; CTA is "Connect".
//   connecting-privy  — privy.login() is open; cancellable.
//   exchanging        — POST /api/auth/privy in flight; cancellable +
//                       hard-timeout so the user is never stuck on
//                       "Signing in…".
//   authenticated     — OCCA JWT valid + user loaded.
//   error             — last action failed; CTA is "Retry" + error text.
export type AuthStatus =
  | "booting"
  | "idle"
  | "connecting-privy"
  | "exchanging"
  | "authenticated"
  | "error";

export interface UseAuthResult {
  status: AuthStatus;
  user: AuthUser | null;
  error: string | null;
  /** Start (or restart) the connect/exchange pipeline. Idempotent — safe
   *  to call from any non-authenticated state. */
  signIn: () => void;
  /** Sign out of OCCA + Privy fully. */
  signOut: () => void;
  /** Abort the current async op (booting / connecting-privy / exchanging)
   *  and drop back to `idle`. No-op in other states. Lets the user
   *  rescue themselves from a hung modal or stuck "Signing in…". */
  cancel: () => void;
  /** Set (or clear with null) the user's optional display name. Persists
   *  server-side and updates the in-memory user. */
  updateName: (name: string | null) => Promise<void>;
}

const AuthContext = createContext<UseAuthResult | null>(null);

// Privy SDK init (`privy.ready === true`) usually happens within ~500ms.
// If it stalls (StrictMode double-mount aborting fetches, app-config
// 4xx, network blip), we don't wait forever — flip to `idle` so the
// user sees a Connect button and can click to retry the whole thing.
const BOOT_TIMEOUT_MS = 5_000;

// Hard cap on the OCCA JWT exchange. Exceeded → flip to `error` with
// `exchange_timeout`. Server-side privy verify usually completes in
// <500ms, but a stalled fetch (network drop, server restart mid-call)
// could otherwise hang the button at "Signing in…" indefinitely.
const EXCHANGE_TIMEOUT_MS = 15_000;

/**
 * Privy → OCCA JWT bridge.
 *
 * - Privy handles wallet connect / login.
 * - On Privy auth, we POST its access token to `/api/auth/privy`; the
 *   server verifies, extracts the Solana wallet, and returns an OCCA
 *   JWT (24h).
 * - On mount we hydrate from the stored OCCA JWT — if `/api/auth/me`
 *   returns 200 we go straight to `authenticated` without waiting on
 *   Privy. 401 means the JWT is stale (e.g. the user row was wiped from
 *   the DB during dev); we drop the token and let the Privy session
 *   re-exchange to mint a fresh user row.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const privy = usePrivy();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>("booting");
  const [error, setError] = useState<string | null>(null);
  const [hydrationDone, setHydrationDone] = useState(false);

  const hydratedRef = useRef(false);
  // Per-Privy-session guard: never run two exchanges for the same Privy
  // user concurrently or back-to-back without the user explicitly
  // signalling intent (signIn / cancel).
  const exchangedForRef = useRef<string | null>(null);
  // Lets `cancel()` abort the in-flight exchange's fetch + getAccessToken.
  const exchangeCtrlRef = useRef<AbortController | null>(null);

  // ── Hydration ──────────────────────────────────────────────────────
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const token = getStoredToken();
    if (!token) {
      setHydrationDone(true);
      return;
    }
    authApi
      .me()
      .then((res) => {
        setUser(res.user);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          // Stale JWT: drop it and let the Privy-driven exchange below
          // re-mint. DON'T flip to error — the user shouldn't see a
          // failure for a routine "your dev DB was wiped" case.
          setStoredToken(null);
        } else {
          // Unknown failure (network, server 5xx). Surface as error so
          // the user gets a Retry button instead of a dead spinner.
          const msg =
            err instanceof ApiError ? `api_${err.status}` : "hydrate_failed";
          setError(msg);
          setStatus("error");
        }
      })
      .finally(() => {
        setHydrationDone(true);
      });
  }, []);

  // ── Boot watchdog ──────────────────────────────────────────────────
  // Force-exit `booting` after BOOT_TIMEOUT_MS even if Privy never
  // becomes ready. Prevents the wallet button from being permanently
  // hidden when Privy SDK init aborts (a recurring StrictMode issue).
  useEffect(() => {
    if (status !== "booting") return;
    const t = setTimeout(() => {
      setStatus((s) => (s === "booting" ? "idle" : s));
    }, BOOT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [status]);

  // ── Auto-progress from booting once dependencies settle ────────────
  useEffect(() => {
    if (status !== "booting") return;
    if (!hydrationDone) return;

    // JWT was valid → straight to authenticated, no Privy wait needed.
    if (user) {
      setStatus("authenticated");
      return;
    }

    // Privy not yet ready → keep waiting (watchdog will rescue if it
    // never becomes ready).
    if (!privy.ready) return;

    if (!privy.authenticated) {
      setStatus("idle");
      return;
    }

    // Privy already authenticated (carried over session) and we have no
    // OCCA JWT — exchange now.
    triggerExchange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, hydrationDone, user, privy.ready, privy.authenticated]);

  // ── React to Privy session changes once we're past booting ─────────
  useEffect(() => {
    if (status === "booting") return;
    if (status === "exchanging") return;
    if (!privy.ready) return;

    // Privy session went away (logout from elsewhere) — sync down.
    if (!privy.authenticated) {
      exchangedForRef.current = null;
      if (status === "authenticated") {
        // OCCA token is still set in storage but Privy is gone. Clear
        // both so the user starts from a clean slate.
        setStoredToken(null);
        setUser(null);
      }
      if (status !== "idle" && status !== "error") {
        setStatus("idle");
      }
      return;
    }

    // Privy authenticated, no OCCA user → new exchange opportunity. The
    // per-session guard prevents loops; explicit signIn() resets it.
    if (!user && status !== "error" && status !== "connecting-privy") {
      triggerExchange();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privy.ready, privy.authenticated, privy.user?.id, user, status]);

  // ── Exchange driver ────────────────────────────────────────────────
  // Wrapped in a ref-stable function (no React effect deps) so callers
  // — both effects above and the imperative `signIn` — share one path.
  const triggerExchange = useCallback(() => {
    const sessionKey = privy.user?.id ?? "anon";
    if (exchangedForRef.current === sessionKey) return;
    exchangedForRef.current = sessionKey;

    // Fresh AbortController each attempt so cancel() only kills the
    // current exchange.
    const ctrl = new AbortController();
    exchangeCtrlRef.current = ctrl;
    const timeoutId = setTimeout(() => {
      ctrl.abort(new DOMException("exchange_timeout", "TimeoutError"));
    }, EXCHANGE_TIMEOUT_MS);

    setStatus("exchanging");
    setError(null);

    void (async () => {
      try {
        const accessToken = await privy.getAccessToken();
        if (ctrl.signal.aborted) return;
        if (!accessToken) throw new Error("privy_no_access_token");

        // authApi.privy doesn't take a signal yet — wrap with a manual
        // race so cancel/timeout actually short-circuit.
        const exchangePromise = authApi.privy(accessToken);
        const aborted = new Promise<never>((_, reject) => {
          ctrl.signal.addEventListener(
            "abort",
            () => {
              const reason = ctrl.signal.reason;
              reject(
                reason instanceof Error
                  ? reason
                  : new Error("exchange_aborted"),
              );
            },
            { once: true },
          );
        });
        const { token, user: signedUser } = await Promise.race([
          exchangePromise,
          aborted,
        ]);
        if (ctrl.signal.aborted) return;

        setStoredToken(token);
        setUser(signedUser);
        setStatus("authenticated");
      } catch (err) {
        if (ctrl.signal.aborted) {
          // Distinguish user-cancel (state already moved to idle) from
          // timeout (we want to surface as error).
          if ((ctrl.signal.reason as Error)?.name === "TimeoutError") {
            setError("exchange_timeout");
            setStatus("error");
          }
          return;
        }
        const msg =
          err instanceof ApiError
            ? typeof err.body === "object" && err.body && "error" in err.body
              ? String((err.body as Record<string, unknown>).error)
              : `api_${err.status}`
            : err instanceof Error
              ? err.message
              : "sign_in_failed";
        setError(msg);
        setStatus("error");
      } finally {
        clearTimeout(timeoutId);
        if (exchangeCtrlRef.current === ctrl) {
          exchangeCtrlRef.current = null;
        }
      }
    })();
  }, [privy]);

  // ── Imperative actions ─────────────────────────────────────────────
  const signIn = useCallback(() => {
    setError(null);
    // Already authenticated to Privy but no OCCA JWT — re-exchange.
    // Reset the per-session guard so the exchange driver actually runs.
    if (privy.authenticated) {
      exchangedForRef.current = null;
      triggerExchange();
      return;
    }
    setStatus("connecting-privy");
    try {
      privy.login();
    } catch (err) {
      // Privy throws synchronously if app config is broken; surface it
      // instead of leaving the user stuck on "Connecting…".
      const msg = err instanceof Error ? err.message : "privy_login_failed";
      setError(msg);
      setStatus("error");
    }
  }, [privy, triggerExchange]);

  const cancel = useCallback(() => {
    if (
      status === "booting" ||
      status === "connecting-privy" ||
      status === "exchanging"
    ) {
      exchangeCtrlRef.current?.abort(
        new DOMException("user_cancelled", "AbortError"),
      );
      setStatus("idle");
      setError(null);
    }
  }, [status]);

  const signOut = useCallback(() => {
    exchangeCtrlRef.current?.abort(
      new DOMException("user_signed_out", "AbortError"),
    );
    setStoredToken(null);
    setUser(null);
    setError(null);
    // Don't reset exchangedForRef here. `privy.logout()` is async; if
    // we cleared the ref now, the Privy-watcher effect would still see
    // `privy.authenticated === true` for one more tick and silently
    // re-exchange the user back in. The ref clears naturally on the
    // first tick where Privy reports unauthenticated.
    void privy.logout();
    setStatus("idle");
  }, [privy]);

  const updateName = useCallback(async (name: string | null) => {
    const res = await meApi.updateName(name);
    setUser(res.user);
  }, []);

  const value = useMemo<UseAuthResult>(
    () => ({ status, user, error, signIn, signOut, cancel, updateName }),
    [status, user, error, signIn, signOut, cancel, updateName],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Auth provider for builds without Privy configured (no
 * NEXT_PUBLIC_PRIVY_APP_ID — e.g. the open-source mirror before an operator
 * sets up Privy). It calls no Privy hooks, so the app boots and public
 * routes like /demo render instead of crashing on PrivyProvider init. The
 * login screen surfaces the `privy_not_configured` message. Pair with the
 * `PRIVY_ENABLED` branch in providers so PrivyProvider never mounts with an
 * empty app id.
 */
export function DisabledAuthProvider({ children }: { children: ReactNode }) {
  const value = useMemo<UseAuthResult>(
    () => ({
      status: "error",
      user: null,
      error: "privy_not_configured",
      signIn: () => {},
      signOut: () => {},
      cancel: () => {},
      updateName: async () => {},
    }),
    [],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): UseAuthResult {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
