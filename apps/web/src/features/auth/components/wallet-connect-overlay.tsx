"use client";

import { useCallback, useRef, useState } from "react";
import { Check, Copy, LogOut, Wallet as WalletIcon } from "lucide-react";
import { useAuth } from "@/features/auth/hooks/use-auth";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { cn } from "@/lib/utils";

function truncate(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

interface WalletConnectOverlayProps {
  /** When true, render the trigger button as an inline cell (no fixed
   *  positioning, no own glass surface) for embedding inside the
   *  TopMenuBar. The dropdown still anchors to the trigger via a
   *  FloatingPanel portal. */
  embedded?: boolean;
}

export function WalletConnectOverlay({
  embedded = false,
}: WalletConnectOverlayProps = {}) {
  const { status, user, error, signIn, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const [copied, setCopied] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const openMenu = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect() ?? null;
    setTriggerRect(rect);
    setMenuOpen(true);
  }, []);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setTriggerRect(null);
  }, []);

  const onCopy = useCallback(async () => {
    if (!user?.walletAddress) return;
    try {
      await navigator.clipboard.writeText(user.walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* noop */
    }
  }, [user?.walletAddress]);

  // Render nothing while auth is still hydrating — prevents a "Sign in"
  // flash on reload for users with a valid prior OCCA session.
  if (status === "hydrating") return null;

  // Embedded mode: pill (rounded-full bg, no border) with truncated
  // address inline — only this item in the top bar carries a bg, the
  // rest sit plain on the page.
  // Standalone mode: own glass pill (legacy fallback when not in TopMenuBar).
  const triggerBase = embedded
    ? "flex items-center gap-2 rounded-full bg-white/10 px-3 h-8 text-sm font-medium transition hover:bg-white/15"
    : "glass-heavy flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition hover:bg-white/12";

  const trigger =
    status === "authenticated" && user ? (
      <>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => (menuOpen ? closeMenu() : openMenu())}
          aria-expanded={menuOpen}
          className={cn(
            triggerBase,
            "text-white/90",
            menuOpen && "bg-white/15",
          )}
        >
          {truncate(user.walletAddress)}
        </button>

        {menuOpen && (
          <FloatingPanel
            title="Wallet"
            subtitle="Solana"
            width={300}
            triggerRect={triggerRect}
            onClose={closeMenu}
          >
            <div className="p-3 space-y-3">
              {/* Address row — full address, click to copy */}
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

              {/* Actions */}
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
      </>
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
