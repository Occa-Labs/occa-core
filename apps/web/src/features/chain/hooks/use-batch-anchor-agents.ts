"use client";

import { useCallback, useRef, useState } from "react";
import {
  useSignTransaction as useSolanaSignTransaction,
  useWallets as useSolanaWallets,
} from "@privy-io/react-auth/solana";
import { chainApi } from "@/lib/api";
import { SOLANA_CAIP_CHAIN } from "@/lib/env-flags";
import {
  type AnchorErrorCode,
  classifyWalletError,
  mapServerError,
} from "../lib/anchor-errors";

type SolanaWallet = ReturnType<typeof useSolanaWallets>["wallets"][number];

export type BatchAnchorStage =
  | "idle"
  | "preparing"
  | "ready-to-sign"
  | "awaiting-signature"
  | "deriving-keypairs"
  | "registering"
  | "complete";

export interface BatchAnchorError {
  code: AnchorErrorCode;
  message: string;
  stage: Exclude<BatchAnchorStage, "idle" | "complete" | "ready-to-sign">;
}

export interface BatchAnchorResult {
  companyPda: string;
  newlyRegistered: number;
  alreadyRegistered: number;
  registered: Array<{
    agentId: string;
    agentPda: string | null;
    agentIndex: number | null;
    agentChainTxSignature: string | null;
    alreadyRegistered: boolean;
  }>;
}

export interface UseBatchAnchorAgentsResult {
  stage: BatchAnchorStage;
  error: BatchAnchorError | null;
  result: BatchAnchorResult | null;
  totalNew: number;
  prepare: (input: { companyId: string; agentIds: string[] }) => Promise<void>;
  signAndRegister: (input: {
    companyId: string;
    wallet: SolanaWallet;
  }) => Promise<void>;
  reset: () => void;
}

const log = (...args: unknown[]) => {
  if (typeof window !== "undefined") console.log("[batch-anchor]", ...args);
};

function toBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1)
    bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

interface PreparedDeployment {
  agentId: string;
  agentPubkey: string;
  agentIndex: number;
  agentPda: string;
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

interface AlreadyRegisteredDeployment {
  agentId: string;
  agentPda: string;
  agentIndex: number;
}

/**
 * Batch deployment anchor: one wallet popup → N combined-tx
 * (register_agent_identity + create_deployment) per agent.
 *
 * Flow per run:
 *   1. `prepare(companyId, agentIds)`:
 *        Call `prepareAgent(id)` for each \u2014 for new ones the server
 *        returns a base64 fee-payer-presigned tx; for already-anchored
 *        ones it returns `alreadyRegistered: true`.
 *   2. `signAndRegister(wallet)`:
 *        - Privy `signTransaction(...inputs)` signs all pending txs in
 *          one popup (wallets supporting batch).
 *        - Server `confirmAgent` is then called per signed tx; server
 *          submits the raw tx, confirms, and persists.
 *
 * If the wallet doesn't support batch sign (returns single output for a
 * single input), we transparently fall back to sequential (N popups).
 */
export function useBatchAnchorAgents(): UseBatchAnchorAgentsResult {
  const { signTransaction } = useSolanaSignTransaction();
  const [stage, setStage] = useState<BatchAnchorStage>("idle");
  const [error, setError] = useState<BatchAnchorError | null>(null);
  const [result, setResult] = useState<BatchAnchorResult | null>(null);
  const [totalNew, setTotalNew] = useState(0);
  const inFlightRef = useRef(false);

  const prepRef = useRef<{
    companyId: string;
    pending: PreparedDeployment[];
    already: AlreadyRegisteredDeployment[];
  } | null>(null);

  const reset = useCallback(() => {
    setStage("idle");
    setError(null);
    setResult(null);
    setTotalNew(0);
    prepRef.current = null;
    inFlightRef.current = false;
  }, []);

  // ── Phase A ──────────────────────────────────────────────────────────
  const prepare = useCallback(
    async ({
      companyId,
      agentIds,
    }: {
      companyId: string;
      agentIds: string[];
    }) => {
      if (inFlightRef.current) return;
      if (agentIds.length === 0) {
        setStage("complete");
        setResult({
          companyPda: "",
          newlyRegistered: 0,
          alreadyRegistered: 0,
          registered: [],
        });
        return;
      }
      inFlightRef.current = true;
      setError(null);
      setStage("preparing");
      log("prepare start", { companyId, count: agentIds.length });
      try {
        const pending: PreparedDeployment[] = [];
        const already: AlreadyRegisteredDeployment[] = [];
        for (const agentId of agentIds) {
          // eslint-disable-next-line no-await-in-loop
          const res = await chainApi.prepareCombinedAgent(agentId);
          if (res.alreadyRegistered) {
            already.push({
              agentId,
              agentPda: res.agentPda,
              agentIndex: res.agentIndex,
            });
          } else {
            pending.push({
              agentId,
              agentPubkey: res.agentPubkey,
              agentIndex: res.agentIndex,
              agentPda: res.agentPda,
              transaction: res.transaction,
              blockhash: res.blockhash,
              lastValidBlockHeight: res.lastValidBlockHeight,
            });
          }
        }
        prepRef.current = { companyId, pending, already };
        setTotalNew(pending.length);
        log("prepare ok", { new: pending.length, already: already.length });

        if (pending.length === 0) {
          setResult({
            companyPda: "",
            newlyRegistered: 0,
            alreadyRegistered: already.length,
            registered: already.map((h) => ({
              agentId: h.agentId,
              agentPda: h.agentPda,
              agentIndex: h.agentIndex,
              agentChainTxSignature: null,
              alreadyRegistered: true,
            })),
          });
          setStage("complete");
          return;
        }

        setStage("ready-to-sign");
      } catch (err) {
        const m = mapServerError(err);
        setError({ ...m, stage: "preparing" });
        setStage("idle");
      } finally {
        inFlightRef.current = false;
      }
    },
    [],
  );

  // ── Phase B ──────────────────────────────────────────────────────────
  const signAndRegister = useCallback(
    async ({
      companyId,
      wallet,
    }: {
      companyId: string;
      wallet: SolanaWallet;
    }) => {
      if (inFlightRef.current) return;
      const prep = prepRef.current;
      if (!prep || prep.companyId !== companyId) {
        setError({
          code: "unknown",
          message: "Call prepare() before signing.",
          stage: "awaiting-signature",
        });
        return;
      }
      if (prep.pending.length === 0) {
        setStage("complete");
        return;
      }

      inFlightRef.current = true;
      setError(null);
      setStage("awaiting-signature");
      log("signAndRegister start", {
        wallet: wallet.address,
        new: prep.pending.length,
      });

      try {
        // Sign every pending tx in one popup if the wallet supports
        // variadic input. Otherwise fall back to sequential signing.
        let signedBytesList: Uint8Array[];
        try {
          if (prep.pending.length === 1) {
            const out = await signTransaction({
              transaction: toBytes(prep.pending[0].transaction),
              wallet,
              chain: SOLANA_CAIP_CHAIN,
            });
            signedBytesList = [out.signedTransaction];
          } else {
            const inputs = prep.pending.map((h) => ({
              transaction: toBytes(h.transaction),
              wallet,
              chain: SOLANA_CAIP_CHAIN,
            }));
            const outs = await signTransaction(...inputs);
            signedBytesList = outs.map((o) => o.signedTransaction);
          }
        } catch (err) {
          // Wallet rejected / failed to simulate (e.g. not enough SOL for
          // fees + ATA rent). Reset to `idle`, NOT `ready-to-sign`: the
          // panel auto-fires signAndRegister on every `ready-to-sign`
          // transition, so resting there would immediately re-open the
          // wallet popup in a loop the user can't cancel. From `idle` the
          // error shows and the Anchor button is clickable again to retry.
          log("signTransaction failed", err);
          const m = classifyWalletError(err);
          setError({ ...m, stage: "awaiting-signature" });
          setStage("idle");
          return;
        }

        setStage("registering");
        const registered: BatchAnchorResult["registered"] = [];
        for (let i = 0; i < prep.pending.length; i += 1) {
          const dep = prep.pending[i];
          const signedBytes = signedBytesList[i];
          try {
            // eslint-disable-next-line no-await-in-loop
            const res = await chainApi.confirmCombinedAgent(dep.agentId, {
              signedTransaction: toBase64(signedBytes),
              blockhash: dep.blockhash,
              lastValidBlockHeight: dep.lastValidBlockHeight,
              agentPubkey: dep.agentPubkey,
              agentIndex: dep.agentIndex,
            });
            registered.push({
              agentId: dep.agentId,
              agentPda: res.agentPda,
              agentIndex: res.agentIndex,
              agentChainTxSignature: res.agentChainTxSignature,
              alreadyRegistered: res.alreadyRegistered,
            });
          } catch (err) {
            const m = mapServerError(err);
            setError({ ...m, stage: "registering" });
            return;
          }
        }
        for (const a of prep.already) {
          registered.push({
            agentId: a.agentId,
            agentPda: a.agentPda,
            agentIndex: a.agentIndex,
            agentChainTxSignature: null,
            alreadyRegistered: true,
          });
        }
        const newlyRegistered = registered.filter(
          (r) => !r.alreadyRegistered,
        ).length;
        const alreadyRegistered = registered.filter(
          (r) => r.alreadyRegistered,
        ).length;
        setResult({
          companyPda: "",
          newlyRegistered,
          alreadyRegistered,
          registered,
        });
        setStage("complete");
        log("complete", { newlyRegistered, alreadyRegistered });
      } finally {
        inFlightRef.current = false;
      }
    },
    [signTransaction],
  );

  return {
    stage,
    error,
    result,
    totalNew,
    prepare,
    signAndRegister,
    reset,
  };
}
