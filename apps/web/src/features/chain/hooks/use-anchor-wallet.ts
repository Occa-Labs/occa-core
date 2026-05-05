"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";

// Privy doesn't export ConnectedStandardSolanaWallet type publicly in a
// stable path across versions, so we infer it from useSolanaWallets().
type SolanaWallet = ReturnType<typeof useSolanaWallets>["wallets"][number];

export type AnchorWalletStatus =
  | { kind: "loading" }
  | { kind: "no-wallet" }
  | {
      kind: "mismatch";
      expectedAddress: string;
      availableAddresses: string[];
    }
  | { kind: "ready"; wallet: SolanaWallet };

/**
 * Resolve the Solana wallet to use for on-chain anchoring.
 *
 * Selection rules:
 *   1. Wait until Privy reports `ready`.
 *   2. If the user has a Privy "identity" address (`user.wallet.address`),
 *      we MUST sign with that exact wallet — anchoring binds the agent to
 *      that key on the server side.
 *   3. Otherwise prefer the embedded ("privy") wallet, then any external.
 *
 * This hook is the single source of truth for wallet readiness in the
 * anchor flow — `use-anchor-identity` accepts the resolved wallet as an
 * argument and stays Privy-agnostic.
 */
export function useAnchorWallet(): AnchorWalletStatus {
  const { ready: walletsReady, wallets } = useSolanaWallets();
  const { ready: privyReady, user } = usePrivy();

  if (!privyReady || !walletsReady) {
    return { kind: "loading" };
  }

  if (wallets.length === 0) {
    return { kind: "no-wallet" };
  }

  const identityAddress = user?.wallet?.address ?? null;

  if (identityAddress) {
    const matched = wallets.find((w) => w.address === identityAddress);
    if (matched) return { kind: "ready", wallet: matched };
    return {
      kind: "mismatch",
      expectedAddress: identityAddress,
      availableAddresses: wallets.map((w) => w.address),
    };
  }

  return { kind: "ready", wallet: wallets[0] };
}
