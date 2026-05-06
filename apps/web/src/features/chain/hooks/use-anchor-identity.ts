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
  // Company done, identity sign next.
  | "ready-to-sign-identity"
  | "registering-identity"
  // Identity done, deployment sign next. (Replaces the old "ready-to-sign"
  // which was Phase A→B transition; now Phase A→B→C with a third button.)
  | "ready-to-sign"
  | "awaiting-signature"
  | "registering-agent"
  | "complete";

export interface AnchorError {
  code: AnchorErrorCode;
  message: string;
  stage: Exclude<
    AnchorStage,
    "idle" | "complete" | "ready-to-sign-identity" | "ready-to-sign"
  >;
}

export interface AnchorResult {
  companyPda: string;
  identityPda: string;
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
  /** Phase B: register the portable AgentIdentity PDA on-chain. Required
   *  before Phase C — `create_deployment` references the identity PDA.
   *  MUST be invoked from a user gesture (wallet popups need a click). */
  registerIdentity: (input: {
    identityId: string;
    wallet: SolanaWallet;
  }) => Promise<void>;
  /** Phase C: register the Deployment PDA (ties the identity to a
   *  company). MUST be invoked from a user gesture. */
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
  const identityPdaRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  const reset = useCallback(() => {
    setStage("idle");
    setError(null);
    setResult(null);
    companyPdaRef.current = null;
    identityPdaRef.current = null;
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
        setStage("ready-to-sign-identity");
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
          setStage("ready-to-sign-identity");
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
        setStage("ready-to-sign-identity");
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
  const registerIdentity = useCallback(
    async ({
      identityId,
      wallet,
    }: {
      identityId: string;
      wallet: SolanaWallet;
    }) => {
      if (inFlightRef.current) {
        log("registerIdentity ignored — in flight");
        return;
      }
      if (!companyPdaRef.current) {
        setError({
          code: "unknown",
          message: "Phase A must complete before signing identity.",
          stage: "registering-identity",
        });
        return;
      }
      if (identityPdaRef.current) {
        setStage("ready-to-sign");
        return;
      }

      inFlightRef.current = true;
      setError(null);
      setStage("registering-identity");
      log("registerIdentity start", { identityId });

      try {
        const prepRes = await chainApi.prepareIdentity(identityId);
        if (prepRes.alreadyRegistered) {
          identityPdaRef.current = prepRes.identityPda;
          log("registerIdentity already on-chain", prepRes);
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
          log("registerIdentity signTransaction failed", err);
          const m = classifyWalletError(err);
          setError({ ...m, stage: "registering-identity" });
          // Drop back to ready-to-sign-identity so the user can retry the
          // identity sign without re-running Phase A.
          setStage("ready-to-sign-identity");
          return;
        }

        const confirmRes = await chainApi.confirmIdentity(identityId, {
          signedTransaction: toBase64(signedBytes),
          blockhash: prepRes.blockhash,
          lastValidBlockHeight: prepRes.lastValidBlockHeight,
          agentPubkey: prepRes.agentPubkey,
        });
        identityPdaRef.current = confirmRes.identityPda;
        log("registerIdentity ok", { identityPda: confirmRes.identityPda });
        setStage("ready-to-sign");
      } catch (err) {
        const m = mapServerError(err);
        setError({ ...m, stage: "registering-identity" });
      } finally {
        inFlightRef.current = false;
      }
    },
    [signTransaction],
  );

  // ── Phase C ───────────────────────────────────────────────────────
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
      if (!identityPdaRef.current) {
        setError({
          code: "unknown",
          message: "Phase B (identity) must complete before signing deployment.",
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
            identityPda: identityPdaRef.current,
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
            identityPda: identityPdaRef.current,
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
    registerIdentity,
    signAndRegisterAgent,
    reset,
  };
}
