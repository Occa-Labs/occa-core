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

export type AnchorStage =
  | "idle"
  | "registering-company"
  | "ready-to-sign"
  | "awaiting-signature"
  | "registering-agent"
  | "complete";

export interface AnchorError {
  code: AnchorErrorCode;
  message: string;
  stage: Exclude<AnchorStage, "idle" | "complete" | "ready-to-sign">;
}

export interface AnchorResult {
  companyPda: string;
  agentPda: string;
  agentIndex: number;
  agentChainTxSignature: string | null;
}

export interface UseAnchorIdentityResult {
  stage: AnchorStage;
  error: AnchorError | null;
  result: AnchorResult | null;
  /** Phase A: register company on-chain. Idempotent, safe to auto-run. */
  registerCompany: (input: {
    companyId: string;
    wallet: SolanaWallet;
  }) => Promise<void>;
  /** Phase B: register the CEO agent on-chain. MUST be invoked from a
   *  user gesture (e.g. button onClick) — wallets like Phantom silently
   *  no-op signTransaction requests originating from useEffect. */
  signAndRegisterAgent: (input: {
    agentId: string;
    wallet: SolanaWallet;
  }) => Promise<void>;
  reset: () => void;
}

const log = (...args: unknown[]) => {
  if (typeof window !== "undefined") console.log("[anchor]", ...args);
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

export function useAnchorIdentity(): UseAnchorIdentityResult {
  const { signTransaction } = useSolanaSignTransaction();
  const [stage, setStage] = useState<AnchorStage>("idle");
  const [error, setError] = useState<AnchorError | null>(null);
  const [result, setResult] = useState<AnchorResult | null>(null);
  const companyPdaRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  const reset = useCallback(() => {
    setStage("idle");
    setError(null);
    setResult(null);
    companyPdaRef.current = null;
    inFlightRef.current = false;
  }, []);

  // ── Phase A ───────────────────────────────────────────────────────
  const registerCompany = useCallback(
    async ({
      companyId,
      wallet,
    }: {
      companyId: string;
      wallet: SolanaWallet;
    }) => {
      if (inFlightRef.current) return;
      if (companyPdaRef.current) {
        setStage("ready-to-sign");
        return;
      }
      inFlightRef.current = true;
      setError(null);
      setStage("registering-company");
      log("registerCompany prepare", { companyId });
      try {
        const prepRes = await chainApi.prepareCompany(companyId);
        if (prepRes.alreadyRegistered) {
          companyPdaRef.current = prepRes.companyPda;
          log("registerCompany already on-chain", {
            companyPda: prepRes.companyPda,
          });
          setStage("ready-to-sign");
          return;
        }

        let signedBytes: Uint8Array;
        try {
          const signRes = await signTransaction({
            transaction: toBytes(prepRes.transaction),
            wallet,
            chain: SOLANA_CAIP_CHAIN,
          });
          signedBytes = signRes.signedTransaction;
        } catch (err) {
          log("registerCompany signTransaction failed", err);
          const m = classifyWalletError(err);
          setError({ ...m, stage: "registering-company" });
          setStage("idle");
          return;
        }

        const confirmRes = await chainApi.confirmCompany(companyId, {
          signedTransaction: toBase64(signedBytes),
          blockhash: prepRes.blockhash,
          lastValidBlockHeight: prepRes.lastValidBlockHeight,
          nonce: prepRes.chainNonce,
        });
        companyPdaRef.current = confirmRes.companyPda;
        log("registerCompany ok", { companyPda: confirmRes.companyPda });
        setStage("ready-to-sign");
      } catch (err) {
        const m = mapServerError(err);
        setError({ ...m, stage: "registering-company" });
        setStage("idle");
      } finally {
        inFlightRef.current = false;
      }
    },
    [signTransaction],
  );

  // ── Phase B ───────────────────────────────────────────────────────
  const signAndRegisterAgent = useCallback(
    async ({ agentId, wallet }: { agentId: string; wallet: SolanaWallet }) => {
      if (inFlightRef.current) {
        log("signAndRegisterAgent ignored — in flight");
        return;
      }
      if (!companyPdaRef.current) {
        setError({
          code: "unknown",
          message: "Phase A must complete before signing.",
          stage: "awaiting-signature",
        });
        return;
      }

      inFlightRef.current = true;
      setError(null);
      log("signAndRegisterAgent start", {
        agentId,
        walletAddress: wallet.address,
      });

      try {
        setStage("awaiting-signature");
        const prepRes = await chainApi.prepareAgent(agentId);
        if (prepRes.alreadyRegistered) {
          setResult({
            companyPda: companyPdaRef.current,
            agentPda: prepRes.agentPda,
            agentIndex: prepRes.agentIndex,
            agentChainTxSignature: null,
          });
          setStage("complete");
          log("signAndRegisterAgent already on-chain", prepRes);
          return;
        }

        let signedBytes: Uint8Array;
        try {
          const signRes = await signTransaction({
            transaction: toBytes(prepRes.transaction),
            wallet,
            chain: SOLANA_CAIP_CHAIN,
          });
          signedBytes = signRes.signedTransaction;
          log("signTransaction ok", { len: signedBytes.length });
        } catch (err) {
          log("signTransaction failed", err);
          const m = classifyWalletError(err);
          setError({ ...m, stage: "awaiting-signature" });
          setStage("ready-to-sign");
          return;
        }

        setStage("registering-agent");
        try {
          const res = await chainApi.confirmAgent(agentId, {
            signedTransaction: toBase64(signedBytes),
            blockhash: prepRes.blockhash,
            lastValidBlockHeight: prepRes.lastValidBlockHeight,
            agentIndex: prepRes.agentIndex,
          });
          setResult({
            companyPda: companyPdaRef.current,
            agentPda: res.agentPda,
            agentIndex: res.agentIndex,
            agentChainTxSignature: res.agentChainTxSignature,
          });
          setStage("complete");
          log("complete", { agentPda: res.agentPda });
        } catch (err) {
          const m = mapServerError(err);
          setError({ ...m, stage: "registering-agent" });
        }
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
    registerCompany,
    signAndRegisterAgent,
    reset,
  };
}
