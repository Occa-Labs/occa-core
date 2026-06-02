"use client";

import { useCallback, useRef, useState, type ReactElement } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  LogOut,
  RefreshCw,
  Wallet as WalletIcon,
  X,
} from "lucide-react";
import { useAuth } from "@/features/auth/hooks/use-auth";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

function truncate(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

interface WalletConnectOverlayProps {
  /** When true, render the trigger as an inline cell for embedding
   *  inside the TopMenuBar. Dropdowns + popovers still anchor to the
   *  trigger via FloatingPanel portals. */
  embedded?: boolean;
}

// Maps raw error codes from server / Privy / our own state machine to a
// user-readable string. Falls back to the raw code in dev so we don't
// hide unknown errors silently.
function prettifyAuthError(code: string): string {
  switch (code) {
    case "exchange_timeout":
      return "Sign-in timed out. Check your connection and retry.";
    case "privy_no_access_token":
      return "Wallet session expired. Reconnect and try again.";
    case "privy_login_failed":
      return "Wallet connect failed. Try again or reload the page.";
    case "privy_token_invalid":
      return "Privy session is invalid. Reconnect to refresh.";
    case "privy_no_solana_wallet":
      return "No Solana wallet linked to this Privy account.";
    case "privy_not_configured":
      return "Server is not configured for Privy. Contact support.";
    case "hydrate_failed":
      return "Couldn't reach the server. Retry when it's back up.";
    case "sign_in_failed":
      return "Sign-in failed. Retry or reload the page.";
    default:
      return code;
  }
}

export function WalletConnectOverlay({
  embedded = false,
}: WalletConnectOverlayProps = {}) {
  const { status, user, error, signIn, signOut, cancel } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [errorOpen, setErrorOpen] = useState(false);
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const [copied, setCopied] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const captureTriggerRect = useCallback(() => {
    setTriggerRect(triggerRef.current?.getBoundingClientRect() ?? null);
  }, []);

  const openMenu = useCallback(() => {
    captureTriggerRect();
    setMenuOpen(true);
  }, [captureTriggerRect]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setTriggerRect(null);
  }, []);

  const openErrorPopover = useCallback(() => {
    captureTriggerRect();
    setErrorOpen(true);
  }, [captureTriggerRect]);

  const closeErrorPopover = useCallback(() => {
    setErrorOpen(false);
    setTriggerRect(null);
  }, []);

  const onCopy = useCallback(async () => {
    if (!user?.walletAddress) return;
    try {
      await navigator.clipboard.writeText(user.walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard denied — silent */
    }
  }, [user?.walletAddress]);

  // Pill base — embedded sits inline in the top bar with no border;
  // standalone carries its own glass surface for legacy positioning.
  const triggerBase = embedded
    ? "flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 h-7 text-xs font-medium transition hover:bg-white/15"
    : "glass-heavy flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition hover:bg-white/12";

  const inFlight =
    status === "booting" ||
    status === "connecting-privy" ||
    status === "exchanging";

  const inFlightLabel =
    status === "booting"
      ? "Loading…"
      : status === "connecting-privy"
        ? "Connecting…"
        : "Signing in…";

  // ── Trigger render ────────────────────────────────────────────────
  let trigger: ReactElement;

  if (status === "authenticated" && user) {
    trigger = (
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (menuOpen ? closeMenu() : openMenu())}
        aria-expanded={menuOpen}
        className={cn(triggerBase, "text-white/90", menuOpen && "bg-white/15")}
      >
        {truncate(user.walletAddress)}
      </button>
    );
  } else if (inFlight) {
    // One unified pill for all in-flight states. Clicking the X cancels
    // back to idle so the user is never stuck if Privy hangs / network
    // drops mid-exchange. The pill body itself isn't clickable — only
    // the X is — so users don't accidentally cancel by misclicking.
    trigger = (
      <span
        ref={triggerRef as unknown as React.Ref<HTMLSpanElement>}
        className={cn(triggerBase, "text-white/70 cursor-default")}
      >
        {/* Explicit `variant` — Spinner randomizes by default which
            causes an SSR/CSR hydration mismatch (TopMenuBar renders
            server-side). Pinning the variant keeps the markup stable. */}
        <Spinner variant="block" className="text-sm text-white/70" />
        {inFlightLabel}
        <button
          type="button"
          onClick={cancel}
          aria-label="Cancel"
          className="ml-1 -mr-1 size-5 rounded-full flex items-center justify-center text-white/50 hover:text-white hover:bg-white/15 transition-colors cursor-pointer"
        >
          <X className="size-3" />
        </button>
      </span>
    );
  } else if (status === "error") {
    // Two-part trigger: primary "Retry" action + secondary error icon
    // that opens a popover with the full message. Embedded-friendly:
    // single pill, error visible without leaving the menu bar.
    trigger = (
      <span className={cn(triggerBase, "text-white pr-1")}>
        <button
          type="button"
          onClick={signIn}
          className="flex items-center gap-2 cursor-pointer"
        >
          <RefreshCw className="size-4" />
          Retry sign in
        </button>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => (errorOpen ? closeErrorPopover() : openErrorPopover())}
          aria-label="Show error details"
          aria-expanded={errorOpen}
          className="ml-1 size-5 rounded-full flex items-center justify-center text-red-300 hover:text-red-200 hover:bg-red-500/20 transition-colors cursor-pointer"
        >
          <AlertCircle className="size-3.5" />
        </button>
      </span>
    );
  } else {
    // status === "idle"
    trigger = (
      <button
        ref={triggerRef}
        type="button"
        onClick={signIn}
        className={cn(triggerBase, "text-white cursor-pointer")}
      >
        <WalletIcon className="h-4 w-4" />
        Connect wallet
      </button>
    );
  }

  // ── Floating panels (auth menu + error popover) ────────────────────
  const panels = (
    <>
      {menuOpen && status === "authenticated" && user && (
        <FloatingPanel
          title="Wallet"
          subtitle="Solana"
          width={300}
          triggerRect={triggerRect}
          onClose={closeMenu}
        >
          <div className="p-3 space-y-3">
            <div className="rounded-xl bg-white/5 px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-wider text-white/35 font-medium">
                Address
              </p>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 min-w-0 text-[11px] font-mono text-white/85 break-all leading-relaxed">
                  {user.walletAddress}
                </code>
                <button
                  type="button"
                  onClick={onCopy}
                  className="size-7 shrink-0 rounded-md flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors"
                  aria-label="Copy address"
                  title={copied ? "Copied" : "Copy address"}
                >
                  {copied ? (
                    <Check className="size-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                closeMenu();
                signOut();
              }}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-red-300/90 hover:bg-red-500/10 hover:text-red-300 transition-colors"
            >
              <LogOut className="size-4" />
              Disconnect wallet
            </button>
          </div>
        </FloatingPanel>
      )}

      {errorOpen && error && (
        <FloatingPanel
          title="Sign-in failed"
          width={320}
          triggerRect={triggerRect}
          onClose={closeErrorPopover}
        >
          <div className="p-3 space-y-3">
            <p className="text-sm text-white/85 leading-relaxed">
              {prettifyAuthError(error)}
            </p>
            <p className="text-[10px] font-mono text-white/30 break-all">
              code: {error}
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={closeErrorPopover}
                className="rounded-md px-3 py-1.5 text-xs text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={() => {
                  closeErrorPopover();
                  signIn();
                }}
                className="rounded-md bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/15 transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        </FloatingPanel>
      )}
    </>
  );

  if (embedded) {
    return (
      <>
        {trigger}
        {panels}
      </>
    );
  }

  return (
    <>
      <div className="fixed right-4 top-4 z-50 flex flex-col items-end gap-2">
        {trigger}
      </div>
      {panels}
    </>
  );
}
