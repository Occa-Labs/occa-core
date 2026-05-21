"use client";

import type { ReactNode } from "react";
import { Coins, LogOut, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  BYPASS_TOKEN_GATE,
  OCCA_GATE_AMOUNT,
  OCCA_TOKEN_MINT,
  TOKEN_GATE_ALLOWLIST,
} from "@/lib/env-flags";
import {
  useOccaBalance,
  type OccaBalanceStatus,
} from "@/features/auth/hooks/use-occa-balance";

// Where a holder-short user goes to acquire $OCCA. The mint is a
// pump.fun token, so its canonical buy page is pump.fun/coin/<mint>.
const PUMP_FUN_URL = `https://pump.fun/coin/${OCCA_TOKEN_MINT}`;

interface TokenGateProps {
  /** Logged-in wallet to check the $OCCA balance of. */
  walletAddress: string | null;
  /** Sign the user out of OCCA + Privy. */
  onSignOut: () => void;
  /** The OS — rendered only once the wallet clears the gate. */
  children: ReactNode;
}

/**
 * Post-login holder gate. Mounted inside the authenticated branch of
 * the home page: it checks the wallet's $OCCA balance and only mounts
 * `children` (onboarding + OS shell) when the balance meets
 * OCCA_GATE_AMOUNT. Everyone else gets a blocking overlay.
 */
export function TokenGate({
  walletAddress,
  onSignOut,
  children,
}: TokenGateProps) {
  const allowlisted =
    walletAddress !== null && TOKEN_GATE_ALLOWLIST.includes(walletAddress);

  // Dev opt-out + allowlisted wallets — render the OS straight through,
  // no RPC call. Passing `null` keeps the hook idle.
  const { status, balance, error, refetch } = useOccaBalance(
    BYPASS_TOKEN_GATE || allowlisted ? null : walletAddress,
  );

  if (BYPASS_TOKEN_GATE || allowlisted) return <>{children}</>;

  // Check still in flight — hold the OS behind a spinner so the shell
  // never flashes for a wallet that turns out to be under the bar.
  if (status === "idle" || status === "loading") {
    return <TokenGateLoading />;
  }

  if (status === "ready" && balance >= OCCA_GATE_AMOUNT) {
    return <>{children}</>;
  }

  // Insufficient balance, or the RPC check failed — block either way.
  return (
    <TokenGateOverlay
      status={status}
      balance={status === "ready" ? balance : null}
      walletAddress={walletAddress}
      onRefresh={refetch}
      onSignOut={onSignOut}
    />
  );
}

function TokenGateLoading() {
  return (
    <div
      // z-100 — same layer as the production gate, above the window
      // stack (which tops out around z-50).
      className="fixed inset-0 z-100 flex items-center justify-center"
      style={{
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }}
    >
      <Spinner className="size-8 text-white" />
    </div>
  );
}

function shortenAddress(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 4)}…${address.slice(-4)}`
    : address;
}

const numberFmt = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

const compactFmt = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function TokenGateOverlay({
  status,
  balance,
  walletAddress,
  onRefresh,
  onSignOut,
}: {
  status: OccaBalanceStatus;
  balance: number | null;
  walletAddress: string | null;
  onRefresh: () => void;
  onSignOut: () => void;
}) {
  const required = compactFmt.format(OCCA_GATE_AMOUNT);
  const failed = status === "error";

  return (
    <div
      className="fixed inset-0 z-100 flex items-center justify-center px-6"
      style={{
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }}
    >
      <div
        className="max-w-md w-full text-center space-y-6 rounded-3xl px-8 py-10"
        style={{
          background: "rgba(20,20,22,0.72)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          border: "1px solid rgba(255,255,255,0.10)",
          boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
        }}
      >
        <div
          className="size-12 mx-auto rounded-2xl flex items-center justify-center"
          style={{ background: "rgba(255,255,255,0.08)" }}
        >
          <Coins className="size-6 text-white/85" />
        </div>

        <div className="space-y-2">
          <h1 className="text-[20px] font-semibold text-white/90 tracking-tight">
            Holders only
          </h1>
          <p className="text-[13px] text-white/60 leading-relaxed">
            OCCA OS is open to wallets holding at least {required} $OCCA.
          </p>
        </div>

        <div
          className="rounded-2xl px-5 py-4 text-left space-y-3"
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.07)",
          }}
        >
          {failed ? (
            <p className="text-[12px] text-white/55 leading-relaxed">
              Couldn&apos;t read your $OCCA balance right now. Check your
              connection and try again.
            </p>
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-[11px] font-medium text-white/45">
                  Your balance
                </span>
                <span
                  className="text-[15px] font-semibold tracking-tight"
                  style={{ color: "rgb(252,165,165)" }}
                >
                  {numberFmt.format(balance ?? 0)} $OCCA
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-[11px] font-medium text-white/45">
                  Required
                </span>
                <span className="text-[13px] font-medium text-white/70">
                  {required} $OCCA
                </span>
              </div>
            </>
          )}
        </div>

        {walletAddress && (
          <p className="text-[11px] text-white/35">
            Checked wallet {shortenAddress(walletAddress)}
          </p>
        )}

        <div className="flex flex-col gap-2">
          <a
            href={PUMP_FUN_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="block"
          >
            <Button variant="primary" size="lg" block>
              Get $OCCA
            </Button>
          </a>
          <div className="flex gap-2">
            <Button variant="secondary" size="lg" block onClick={onRefresh}>
              <RefreshCw className="size-3.5" />
              Refresh
            </Button>
            <Button variant="ghost" size="lg" block onClick={onSignOut}>
              <LogOut className="size-3.5" />
              Disconnect
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
