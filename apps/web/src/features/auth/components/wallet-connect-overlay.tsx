"use client";

import { useState } from "react";
import { LogOut, Wallet as WalletIcon } from "lucide-react";
import { useAuth } from "@/features/auth/hooks/use-auth";
import { cn } from "@/lib/utils";

function truncate(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

interface WalletConnectOverlayProps {
  /** When true, render the trigger button as an inline cell (no fixed
   *  positioning, no own glass surface) for embedding inside the
   *  TopMenuBar. The dropdown still anchors to the trigger via
   *  `position: relative`. */
  embedded?: boolean;
}

export function WalletConnectOverlay({ embedded = false }: WalletConnectOverlayProps = {}) {
  const { status, user, error, signIn, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  // Render nothing while auth is still hydrating — prevents a "Sign in"
  // flash on reload for users with a valid prior OCCA session.
  if (status === "hydrating") return null;

  // Embedded mode: pill (rounded-full bg, no border) with green dot +
  // truncated address inline — only this item in the top bar carries a
  // bg, the rest sit plain on the page.
  // Standalone mode: own glass pill (legacy fallback when not in TopMenuBar).
  const triggerBase = embedded
    ? "flex items-center gap-2 rounded-full bg-white/10 px-3 h-8 text-sm font-medium transition hover:bg-white/15"
    : "glass-heavy flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition hover:bg-white/12";

  const trigger =
    status === "authenticated" && user ? (
      <div className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className={cn(triggerBase, "text-white/90")}
        >
          <span
            aria-hidden
            className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.5)]"
          />
          {truncate(user.walletAddress)}
        </button>

        {menuOpen && (
          <div className="glass-heavy absolute right-0 mt-2 w-48 overflow-hidden rounded-xl text-sm">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                signOut();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-white/80 transition hover:bg-white/8"
            >
              <LogOut className="h-4 w-4" />
              Disconnect
            </button>
          </div>
        )}
      </div>
    ) : status === "exchanging" ? (
      <button
        type="button"
        disabled
        className={cn(triggerBase, "text-white/70")}
      >
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-300" />
        Signing in…
      </button>
    ) : (
      <button
        type="button"
        onClick={signIn}
        className={cn(triggerBase, "text-white")}
      >
        <WalletIcon className="h-4 w-4" />
        {status === "error" ? "Retry sign in" : "Sign in"}
      </button>
    );

  if (embedded) return trigger;

  return (
    <div className="fixed right-4 top-4 z-50 flex flex-col items-end gap-2">
      {trigger}
      {error && status !== "authenticated" && (
        <div className="glass-dark rounded-lg px-3 py-1.5 text-xs text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
