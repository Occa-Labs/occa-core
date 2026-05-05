"use client";

import { useCallback, useRef, useState } from "react";
import bs58 from "bs58";
import { useSignMessage as useSolanaSignMessage } from "@privy-io/react-auth/solana";
import {
  CURRENT_DERIVATION_MSG_VERSION,
  buildBatchDerivationMessage,
  deriveAgentKeypairForIndex,
} from "occa-sdk";
import { chainApi } from "@/lib/api";
import {
  type AnchorErrorCode,
  classifyWalletError,
  mapServerError,
} from "../lib/anchor-errors";

type SolanaWallet = Parameters<
  ReturnType<typeof useSolanaSignMessage>["signMessage"]
>[0]["wallet"];

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
  /** Number of agents that were freshly anchored in this run. */
  newlyRegistered: number;
  /** Number of agents that were already anchored before this run. */
  alreadyRegistered: number;
  /** Per-hire result. */
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
  /** Total hires this run will anchor (set after `prepare`). */
  totalNew: number;
  /**
   * Phase A: ask server to allocate `agent_index` for each pending hire
   * and return the canonical batch derivation message. Idempotent: rerun
   * is safe, the server reuses pre-reserved indexes.
   */
  prepare: (input: { companyId: string; agentIds: string[] }) => Promise<void>;
  /**
   * Phase B: 1× wallet signature → derive N keypairs → 1+ batch register
   * tx. MUST be invoked from a real user gesture (button onClick).
   */
  signAndRegister: (input: {
    companyId: string;
    wallet: SolanaWallet;
  }) => Promise<void>;
  reset: () => void;
}

const log = (...args: unknown[]) => {
  if (typeof window !== "undefined") console.log("[batch-anchor]", ...args);
};

/**
 * Hybrid (D) batch hire anchor: registers N agents on-chain with a
 * single wallet popup and one (or chunked) Solana transaction.
 *
 * Flow:
 *   1. `prepare(companyId, agentIds)` → server allocates `agent_index`,
 *      persists it, returns the canonical batch derivation message.
 *   2. Caller hands wallet to `signAndRegister` from a button onClick.
 *   3. Hook:
 *      a. Signs the canonical message via Privy (1 popup).
 *      b. Derives N keypairs deterministically from (sig, agent_index).
 *      c. POSTs `batch-register` with all (agentId, agentAddress) pairs
 *         and the single signature.
 *      d. Server verifies, sends batched register_agent tx(s), persists.
 */
export function useBatchAnchorAgents(): UseBatchAnchorAgentsResult {
  const { signMessage } = useSolanaSignMessage();
  const [stage, setStage] = useState<BatchAnchorStage>("idle");
  const [error, setError] = useState<BatchAnchorError | null>(null);
  const [result, setResult] = useState<BatchAnchorResult | null>(null);
  const [totalNew, setTotalNew] = useState(0);
  const inFlightRef = useRef(false);

  // Cached prepare result so signAndRegister doesn't need it passed in.
  const prepRef = useRef<{
    companyId: string;
    companyPda: string;
    derivationMessageVersion: number;
    // Hires that need on-chain registration (have agent_index, no agent_pda).
    newHires: Array<{ agentId: string; agentIndex: number }>;
    alreadyRegisteredCount: number;
    canonicalMessage: string;
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
          companyPda: prepRef.current?.companyPda ?? "",
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
        const res = await chainApi.batchPrepareAgents(companyId, { agentIds });
        const newHires = res.hires
          .filter((h) => !h.alreadyRegistered && h.agentIndex !== null)
          .map((h) => ({ agentId: h.agentId, agentIndex: h.agentIndex! }));
        const alreadyRegisteredCount = res.hires.filter(
          (h) => h.alreadyRegistered,
        ).length;
        prepRef.current = {
          companyId,
          companyPda: res.companyPda,
          derivationMessageVersion: res.derivationMessageVersion,
          newHires,
          alreadyRegisteredCount,
          canonicalMessage: res.batchMessage,
        };
        setTotalNew(newHires.length);
        log("prepare ok", {
          new: newHires.length,
          already: alreadyRegisteredCount,
        });

        if (newHires.length === 0) {
          // Nothing to sign — short-circuit to complete.
          setResult({
            companyPda: res.companyPda,
            newlyRegistered: 0,
            alreadyRegistered: alreadyRegisteredCount,
            registered: res.hires.map((h) => ({
              agentId: h.agentId,
              agentPda: null,
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
      if (inFlightRef.current) {
        log("signAndRegister ignored — in flight");
        return;
      }
      const prep = prepRef.current;
      if (!prep || prep.companyId !== companyId) {
        setError({
          code: "unknown",
          message: "Call prepare() before signing.",
          stage: "awaiting-signature",
        });
        return;
      }
      if (prep.newHires.length === 0) {
        setStage("complete");
        return;
      }

      inFlightRef.current = true;
      setError(null);
      setStage("awaiting-signature");
      log("signAndRegister start", {
        wallet: wallet.address,
        new: prep.newHires.length,
      });

      try {
        // The server-returned `batchMessage` and our locally rebuilt
        // message MUST match byte-for-byte. Rebuild as a defense-in-depth
        // check: if the server tampered with indexes, our derivation
        // would diverge and the server-side verify would reject.
        const localMessage = buildBatchDerivationMessage({
          companyPda: prep.companyPda,
          agentIndexes: prep.newHires.map((h) => h.agentIndex),
          version: prep.derivationMessageVersion,
        });
        if (localMessage !== prep.canonicalMessage) {
          log("canonical message mismatch", {
            server: prep.canonicalMessage,
            local: localMessage,
          });
          setError({
            code: "signature_invalid",
            message: "Batch message mismatch (client vs server).",
            stage: "awaiting-signature",
          });
          setStage("ready-to-sign");
          inFlightRef.current = false;
          return;
        }
        const messageBytes = new TextEncoder().encode(localMessage);

        let signatureBytes: Uint8Array;
        try {
          const sigRes = await signMessage({
            message: messageBytes,
            wallet,
            options: {
              uiOptions: {
                title: `Anchor ${prep.newHires.length} hires on Solana`,
                description:
                  "OCCA derives an on-chain keypair for every hire from this single signature. Your private key never leaves your wallet.",
                buttonText: "Sign once",
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

        setStage("deriving-keypairs");
        const derived = prep.newHires.map((h) => {
          const kp = deriveAgentKeypairForIndex(signatureBytes, h.agentIndex);
          return {
            agentId: h.agentId,
            agentAddress: kp.publicKey.toBase58(),
          };
        });
        const derivationSignature = bs58.encode(signatureBytes);

        setStage("registering");
        try {
          const res = await chainApi.batchRegisterAgents(companyId, {
            derivationSignature,
            derivationMessageVersion: prep.derivationMessageVersion,
            hires: derived,
          });
          const newlyRegistered = res.registered.filter(
            (r) => !r.alreadyRegistered,
          ).length;
          const alreadyRegistered = res.registered.filter(
            (r) => r.alreadyRegistered,
          ).length;
          setResult({
            companyPda: prep.companyPda,
            newlyRegistered,
            alreadyRegistered: prep.alreadyRegisteredCount + alreadyRegistered,
            registered: res.registered.map((r) =>
              r.alreadyRegistered
                ? {
                    agentId: r.agentId,
                    agentPda: r.agentPda,
                    agentIndex: null,
                    agentChainTxSignature: null,
                    alreadyRegistered: true,
                  }
                : {
                    agentId: r.agentId,
                    agentPda: r.agentPda,
                    agentIndex: r.agentIndex,
                    agentChainTxSignature: r.agentChainTxSignature,
                    alreadyRegistered: false,
                  },
            ),
          });
          setStage("complete");
          log("complete", { newlyRegistered, alreadyRegistered });
        } catch (err) {
          const m = mapServerError(err);
          setError({ ...m, stage: "registering" });
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
    totalNew,
    prepare,
    signAndRegister,
    reset,
  };
}
