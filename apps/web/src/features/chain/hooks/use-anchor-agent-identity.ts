"use client";

import { useCallback, useState } from "react";
import { useSignTransaction as useSolanaSignTransaction } from "@privy-io/react-auth/solana";
import { chainApi } from "@/lib/api";
import { SOLANA_CAIP_CHAIN } from "@/lib/env-flags";
import { useAnchorWallet } from "./use-anchor-wallet";
import { classifyWalletError, mapServerError } from "../lib/anchor-errors";

// Standalone anchoring of a portable AgentIdentity (Whitepaper: identity is
// independent of any company). Unlike useAnchorIdentity's 3-phase
// company->identity->deployment chain, this runs ONLY the identity phase
// (register_agent_identity), so an owner can anchor an idle agent with no
// company. The backend route is already identity-scoped.

export type AnchorAgentStage =
  | "idle"
  | "preparing"
  | "awaiting-signature"
  | "confirming"
  | "complete";

function toBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function useAnchorAgentIdentity() {
  const { signTransaction } = useSolanaSignTransaction();
  const walletStatus = useAnchorWallet();
  const [stage, setStage] = useState<AnchorAgentStage>("idle");
  const [error, setError] = useState<string | null>(null);

  const anchor = useCallback(
    async (identityId: string): Promise<boolean> => {
      if (walletStatus.kind !== "ready") {
        setError("Connect your wallet first.");
        return false;
      }
      const wallet = walletStatus.wallet;
      setError(null);
      setStage("preparing");
      try {
        const prep = await chainApi.prepareIdentity(identityId);
        if (prep.alreadyRegistered) {
          setStage("complete");
          return true;
        }

        setStage("awaiting-signature");
        let signed: Uint8Array;
        try {
          const r = await signTransaction({
            transaction: toBytes(prep.transaction),
            wallet,
            chain: SOLANA_CAIP_CHAIN,
          });
          signed = r.signedTransaction;
        } catch (err) {
          setError(classifyWalletError(err).message);
          setStage("idle");
          return false;
        }

        setStage("confirming");
        await chainApi.confirmIdentity(identityId, {
          signedTransaction: toBase64(signed),
          blockhash: prep.blockhash,
          lastValidBlockHeight: prep.lastValidBlockHeight,
          agentPubkey: prep.agentPubkey,
        });
        setStage("complete");
        return true;
      } catch (err) {
        setError(mapServerError(err).message);
        setStage("idle");
        return false;
      }
    },
    [signTransaction, walletStatus],
  );

  return {
    anchor,
    stage,
    error,
    walletReady: walletStatus.kind === "ready",
  };
}
