"use client";

import { useCallback, useEffect, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { OCCA_GATE_RPC, OCCA_TOKEN_MINT } from "@/lib/env-flags";

// Client-side $OCCA balance check that backs the token gate.
//
// The token is a mainnet SPL mint, so this talks to OCCA_GATE_RPC
// (mainnet) directly — not the app's devnet cluster. A wallet address
// is the same base58 string on every cluster, so checking the
// logged-in wallet on mainnet is correct even though the user's agent
// activity happens on devnet.
//
// This is a UI gate only. A determined user can bypass a client check;
// if the gate ever needs to be enforced, the balance check must move
// into the server's /api/auth/privy exchange.

export type OccaBalanceStatus = "idle" | "loading" | "ready" | "error";

export interface UseOccaBalanceResult {
  status: OccaBalanceStatus;
  /** $OCCA held by the wallet, as a decimal-adjusted UI amount. */
  balance: number;
  error: string | null;
  /** Re-run the balance check (e.g. after the user buys $OCCA). */
  refetch: () => void;
}

// One shared Connection for the whole app — avoids re-handshaking the
// RPC on every mount / refetch.
let sharedConnection: Connection | null = null;
function getConnection(): Connection {
  sharedConnection ??= new Connection(OCCA_GATE_RPC, "confirmed");
  return sharedConnection;
}

/**
 * Reads the $OCCA balance for `walletAddress`. Pass `null` to stay
 * `idle` and skip the RPC call entirely (used by the gate's dev
 * bypass).
 */
export function useOccaBalance(
  walletAddress: string | null,
): UseOccaBalanceResult {
  const [status, setStatus] = useState<OccaBalanceStatus>("idle");
  const [balance, setBalance] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Bumped by refetch() to re-trigger the effect.
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!walletAddress) {
      setStatus("idle");
      setBalance(0);
      setError(null);
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);

    void (async () => {
      try {
        const owner = new PublicKey(walletAddress);
        const mint = new PublicKey(OCCA_TOKEN_MINT);
        const res = await getConnection().getParsedTokenAccountsByOwner(
          owner,
          { mint },
        );
        // A wallet can hold the same mint across multiple token
        // accounts — sum every account's UI amount.
        const total = res.value.reduce((sum, { account }) => {
          const parsed = account.data.parsed as
            | { info?: { tokenAmount?: { uiAmount?: number | null } } }
            | undefined;
          const amount = parsed?.info?.tokenAmount?.uiAmount;
          return sum + (typeof amount === "number" ? amount : 0);
        }, 0);
        if (cancelled) return;
        setBalance(total);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "balance_check_failed",
        );
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [walletAddress, nonce]);

  return { status, balance, error, refetch };
}
