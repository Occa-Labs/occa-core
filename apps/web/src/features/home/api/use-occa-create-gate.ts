"use client";

import { useEffect, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  BYPASS_TOKEN_GATE,
  OCCA_CREATE_GATE_PERCENT,
  OCCA_GATE_RPC,
  OCCA_TOKEN_MINT,
  TOKEN_GATE_ALLOWLIST,
} from "@/lib/env-flags";

// Create-company gate: a wallet must hold at least OCCA_CREATE_GATE_PERCENT
// of the total $OCCA supply before it can spin up a company. The OS itself
// is open — this is the one place the balance is enforced, so only wallets
// with real skin in the game create companies.
//
// Like the old OS gate, this is a UI check only. A determined user can
// bypass a client check; real enforcement would move into the server's
// create-company route.

export type CreateGateStatus = "idle" | "loading" | "ready" | "error";

export interface UseOccaCreateGateResult {
  status: CreateGateStatus;
  /** True once the wallet clears the threshold (or is bypassed). */
  eligible: boolean;
  /** Decimal-adjusted $OCCA held by the wallet. */
  balance: number;
  /** Decimal-adjusted $OCCA the wallet must hold (percent of supply). */
  required: number;
  error: string | null;
}

let sharedConnection: Connection | null = null;
function getConnection(): Connection {
  sharedConnection ??= new Connection(OCCA_GATE_RPC, "confirmed");
  return sharedConnection;
}

/**
 * Reads the wallet's $OCCA balance and the mint's total supply, then
 * checks balance >= supply * (percent / 100). Pass `null` to stay idle
 * (no RPC) — the caller arms the check by passing the wallet only when
 * the user actually attempts to create a company.
 */
export function useOccaCreateGate(
  walletAddress: string | null,
): UseOccaCreateGateResult {
  const [status, setStatus] = useState<CreateGateStatus>("idle");
  const [balance, setBalance] = useState(0);
  const [required, setRequired] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const bypassed =
    BYPASS_TOKEN_GATE ||
    (walletAddress !== null && TOKEN_GATE_ALLOWLIST.includes(walletAddress));

  useEffect(() => {
    if (!walletAddress) {
      setStatus("idle");
      return;
    }
    if (bypassed) {
      setStatus("ready");
      setBalance(0);
      setRequired(0);
      setError(null);
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);

    void (async () => {
      try {
        const conn = getConnection();
        const owner = new PublicKey(walletAddress);
        const mint = new PublicKey(OCCA_TOKEN_MINT);

        const [accounts, supply] = await Promise.all([
          conn.getParsedTokenAccountsByOwner(owner, { mint }),
          conn.getTokenSupply(mint),
        ]);

        const held = accounts.value.reduce((sum, { account }) => {
          const parsed = account.data.parsed as
            | { info?: { tokenAmount?: { uiAmount?: number | null } } }
            | undefined;
          const amount = parsed?.info?.tokenAmount?.uiAmount;
          return sum + (typeof amount === "number" ? amount : 0);
        }, 0);

        const totalSupply = supply.value.uiAmount ?? 0;
        const threshold = (totalSupply * OCCA_CREATE_GATE_PERCENT) / 100;

        if (cancelled) return;
        setBalance(held);
        setRequired(threshold);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "create_gate_failed");
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [walletAddress, bypassed]);

  return {
    status,
    eligible: bypassed || (status === "ready" && balance >= required),
    balance,
    required,
    error,
  };
}
