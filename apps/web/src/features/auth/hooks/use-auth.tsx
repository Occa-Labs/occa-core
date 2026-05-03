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
  getStoredToken,
  setStoredToken,
} from "@/lib/api";

export type AuthStatus =
  | "hydrating"          // initial — token check + privy.ready still settling
  | "unauthenticated"    // privy not authenticated
  | "exchanging"         // exchanging privy token for OCCA JWT
  | "authenticated"      // OCCA JWT valid + user loaded
  | "error";

export interface UseAuthResult {
  status: AuthStatus;
  user: AuthUser | null;
  error: string | null;
  /** Trigger Privy login modal. */
  signIn: () => void;
  /** Sign out of OCCA + Privy. */
  signOut: () => void;
}

const AuthContext = createContext<UseAuthResult | null>(null);

/**
 * Privy → OCCA JWT bridge.
 *
 * - Privy handles the wallet connect / login flow (email, Google, wallet).
 * - Once Privy is authenticated, we POST its access token to
 *   `/api/auth/privy`; the server verifies it, extracts the Solana wallet
 *   from the linked accounts, and returns an OCCA JWT (24h).
 * - We hydrate by reading any stored OCCA JWT and calling /me. If valid,
 *   we stay authenticated even if Privy is not yet ready.
 *
 * Address-mismatch logic from the legacy nonce flow is dropped — Privy
 * gives us a single canonical wallet per session. If user switches login
 * provider, Privy reauths and a new exchange happens.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const privy = usePrivy();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>("hydrating");
  const [error, setError] = useState<string | null>(null);
  const [hydrationDone, setHydrationDone] = useState(false);
  const hydratedRef = useRef(false);
  // Guards against the Privy `authenticated` effect running multiple
  // exchanges for the same Privy session.
  const exchangedForRef = useRef<string | null>(null);

  // Hydrate from stored OCCA JWT.
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
          setStoredToken(null);
        }
      })
      .finally(() => {
        setHydrationDone(true);
      });
  }, []);

  // Auto-exchange Privy token → OCCA JWT once Privy is authenticated and we
  // don't already hold a valid JWT.
  useEffect(() => {
    if (status === "exchanging") return;
    if (!hydrationDone || !privy.ready) return;

    if (user) {
      if (status !== "authenticated") setStatus("authenticated");
      return;
    }

    if (!privy.authenticated) {
      exchangedForRef.current = null;
      if (status !== "unauthenticated") setStatus("unauthenticated");
      return;
    }

    // Privy authenticated, no OCCA JWT yet → exchange.
    const sessionKey = privy.user?.id ?? "anon";
    if (exchangedForRef.current === sessionKey) {
      // Already attempted for this session; user must click retry on error.
      if (status === "error") return;
      return;
    }
    exchangedForRef.current = sessionKey;
    void exchange();

    async function exchange() {
      setStatus("exchanging");
      setError(null);
      try {
        const accessToken = await privy.getAccessToken();
        if (!accessToken) {
          throw new Error("privy_no_access_token");
        }
        const { token, user: signedUser } = await authApi.privy(accessToken);
        setStoredToken(token);
        setUser(signedUser);
        setStatus("authenticated");
      } catch (err) {
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
      }
    }
  }, [privy.ready, privy.authenticated, privy.user, user, status, hydrationDone, privy]);

  const signIn = useCallback(() => {
    setError(null);
    privy.login();
  }, [privy]);

  const signOut = useCallback(() => {
    setStoredToken(null);
    setUser(null);
    setError(null);
    // Don't reset `exchangedForRef.current` here. `privy.logout()` is async
    // and during the gap `privy.authenticated` still reads true with the
    // same user id — clearing the ref would let the auto-exchange effect
    // re-fire and silently sign the user back in. The ref is cleared
    // safely by the `!privy.authenticated` branch of that effect once
    // Privy's own state catches up.
    void privy.logout();
    setStatus("unauthenticated");
  }, [privy]);

  const value = useMemo<UseAuthResult>(
    () => ({ status, user, error, signIn, signOut }),
    [status, user, error, signIn, signOut],
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
