"use client";

import { useCallback, useRef, useState } from "react";
import bs58 from "bs58";
import { useSignMessage as useSolanaSignMessage } from "@privy-io/react-auth/solana";
import {
  CURRENT_DERIVATION_MSG_VERSION,
  encodeDerivationMessage,
  deriveAgentKeypairFromSignature,
} from "occa-sdk";
import { chainApi, meApi } from "@/lib/api";
import {
  type AnchorErrorCode,
  classifyWalletError,
  mapServerError,
} from "../lib/anchor-errors";

type SolanaWallet = Parameters<
  ReturnType<typeof useSolanaSignMessage>["signMessage"]
>[0]["wallet"];

export type AnchorStage =
  | "idle"
  | "registering-company"
  | "ready-to-sign"
  | "awaiting-signature"
  | "deriving-keypair"
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
  agentAddress: string;
  agentIndex: number;
  agentChainTxSignature: string | null;
}

export interface UseAnchorIdentityResult {
  stage: AnchorStage;
  error: AnchorError | null;
  result: AnchorResult | null;
  /** Phase A: register company on-chain. Idempotent, safe to auto-run. */
  registerCompany: (companyId: string) => Promise<void>;
  /** Phase B: sign + derive + register agent. MUST be invoked from a user
   *  gesture (e.g. button onClick) — external Solana wallets like Phantom
   *  silently no-op signMessage requests originating from useEffect. */
  signAndRegisterAgent: (input: {
    agentId: string;
    wallet: SolanaWallet;
  }) => Promise<void>;
  reset: () => void;
}

const log = (...args: unknown[]) => {
  if (typeof window !== "undefined") console.log("[anchor]", ...args);
};

export function useAnchorIdentity(): UseAnchorIdentityResult {
  const { signMessage } = useSolanaSignMessage();
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
  const registerCompany = useCallback(async (companyId: string) => {
    if (inFlightRef.current) return;
    if (companyPdaRef.current) {
      // Already done in this session — just advance stage.
      setStage("ready-to-sign");
      return;
    }
    inFlightRef.current = true;
    setError(null);
    setStage("registering-company");
    log("registerCompany start", { companyId });
    try {
      const res = await chainApi.registerCompany(companyId);
      companyPdaRef.current = res.companyPda;
      log("registerCompany ok", { companyPda: res.companyPda });
      setStage("ready-to-sign");
    } catch (err) {
      const m = mapServerError(err);
      setError({ ...m, stage: "registering-company" });
      setStage("idle");
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  // ── Phase B ───────────────────────────────────────────────────────
  const signAndRegisterAgent = useCallback(
    async ({ agentId, wallet }: { agentId: string; wallet: SolanaWallet }) => {
      if (inFlightRef.current) {
        log("signAndRegisterAgent ignored — in flight");
        return;
      }
      const companyPda = companyPdaRef.current;
      if (!companyPda) {
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
        // Discover agentIndex (CEO = 0 unless server pinned).
        const me = await meApi.get().catch(() => null);
        const agentRow = me?.agents.find((a) => a.id === agentId) ?? null;
        const agentIndex = agentRow?.agentIndex ?? 0;

        setStage("awaiting-signature");
        const messageBytes = encodeDerivationMessage({
          companyPda,
          agentIndex,
          version: CURRENT_DERIVATION_MSG_VERSION,
        });
        log("calling signMessage", {
          walletAddress: wallet.address,
          msgBytes: messageBytes.length,
        });

        let signatureBytes: Uint8Array;
        try {
          const sigRes = await signMessage({
            message: messageBytes,
            wallet,
            options: {
              uiOptions: {
                title: "Anchor your CEO on Solana",
                description:
                  "OCCA needs your signature to derive the agent's on-chain keypair. Your private key never leaves your wallet.",
                buttonText: "Sign",
              },
            },
          });
          signatureBytes = sigRes.signature;
          log("signMessage ok", { len: signatureBytes.length });
        } catch (err) {
          log("signMessage failed", err);
          const m = classifyWalletError(err);
          setError({ ...m, stage: "awaiting-signature" });
          setStage("ready-to-sign");
          return;
        }

        setStage("deriving-keypair");
        const agentKeypair = deriveAgentKeypairFromSignature(signatureBytes);
        const agentAddress = agentKeypair.publicKey.toBase58();
        const derivationSignature = bs58.encode(signatureBytes);

        setStage("registering-agent");
        try {
          const res = await chainApi.registerAgent(agentId, {
            agentAddress,
            derivationSignature,
            derivationMessageVersion: CURRENT_DERIVATION_MSG_VERSION,
          });
          setResult({
            companyPda,
            agentPda: res.agentPda,
            agentAddress: res.agentAddress,
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
    [signMessage],
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
