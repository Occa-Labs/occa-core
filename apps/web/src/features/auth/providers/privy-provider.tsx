"use client";

import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import {
  defaultSolanaRpcsPlugin,
  toSolanaWalletConnectors,
} from "@privy-io/react-auth/solana";

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

// Privy needs an RPC entry per CAIP chain the SDK might touch. Even though
// OCCA only operates on devnet, some external wallets (Phantom, etc.)
// advertise `solana:mainnet` in their chain set, and Privy throws
// "No RPC configuration found for chain solana:mainnet" if that cluster
// has no entry. This plugin registers Privy-hosted fallback RPCs for
// both mainnet + devnet — sufficient for our needs since on-chain calls
// still go through the server's operator wallet.
const solanaRpcsPlugin = defaultSolanaRpcsPlugin();

// shouldAutoConnect: false — Privy defaults to true, which iterates every
// detected Solana adapter on page load and tries to silently re-attach.
// "Legacy" adapters (MetaMask Snap, etc.) ignore the silent contract and
// pop their unlock prompt anyway. Disabling auto-connect means a wallet
// only opens when the user explicitly clicks Sign in.
const solanaConnectors = toSolanaWalletConnectors({ shouldAutoConnect: false });

export function AppPrivyProvider({ children }: { children: ReactNode }) {
  if (!APP_ID) {
    // Fail loud in dev — easier than chasing silent "not authenticated" later.
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[privy] NEXT_PUBLIC_PRIVY_APP_ID is not set — sign-in will not work.",
      );
    }
  }

  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        loginMethods: ["email", "wallet"],
        appearance: {
          theme: "dark",
          accentColor: "#5fdcff",
          walletChainType: "solana-only",
        },
        embeddedWallets: {
          solana: {
            createOnLogin: "users-without-wallets",
          },
        },
        externalWallets: {
          solana: { connectors: solanaConnectors },
        },
        plugins: [solanaRpcsPlugin],
      }}
    >
      {children}
    </PrivyProvider>
  );
}
