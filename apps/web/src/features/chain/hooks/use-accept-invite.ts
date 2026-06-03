"use client";

import { useCallback, useState } from "react";
import { useSignTransaction as useSolanaSignTransaction } from "@privy-io/react-auth/solana";
import { marketplaceApi } from "@/lib/api";
import { SOLANA_CAIP_CHAIN } from "@/lib/env-flags";
import { useAnchorWallet } from "./use-anchor-wallet";
import { classifyWalletError, mapServerError } from "../lib/anchor-errors";

export type AcceptInviteStage =
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

// Accept a cross-owner hire invite: the agent owner signs create_deployment,
// which deploys their agent into the inviting company.
export function useAcceptInvite() {
  const { signTransaction } = useSolanaSignTransaction();
  const walletStatus = useAnchorWallet();
  const [stage, setStage] = useState<AcceptInviteStage>("idle");
  const [error, setError] = useState<string | null>(null);

  const accept = useCallback(
    async (inviteId: string): Promise<boolean> => {
      if (walletStatus.kind !== "ready") {
        setError("Connect your wallet first.");
        return false;
      }
      const wallet = walletStatus.wallet;
      setError(null);
      setStage("preparing");
      try {
        const prep = await marketplaceApi.prepareAcceptInvite(inviteId);
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
        await marketplaceApi.confirmAcceptInvite(inviteId, {
          signedTransaction: toBase64(signed),
          blockhash: prep.blockhash,
          lastValidBlockHeight: prep.lastValidBlockHeight,
          deploymentIndex: prep.deploymentIndex,
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

  return { accept, stage, error, walletReady: walletStatus.kind === "ready" };
}
