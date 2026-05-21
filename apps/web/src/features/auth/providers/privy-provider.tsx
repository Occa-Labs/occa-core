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

// shouldAutoConnect: true — modern wallets (Phantom, Solflare) honor the
// silent auto-connect contract: on an already-approved site they re-attach
// on page load WITHOUT a popup, so the connection persists across reloads.
// Without this, an external wallet drops on every re-evaluation and the
// user must reconnect each time they hit a sign flow (set receiving
// address, anchor, etc.) — the friction this re-enable fixes.
//
// Trade-off: "legacy" adapters (MetaMask Snap, etc.) ignore the silent
// contract and may pop their unlock prompt on load. Acceptable — the OCCA
// flow targets Phantom/Solflare, and the reconnect friction was the worse
// of the two annoyances.
const solanaConnectors = toSolanaWalletConnectors({ shouldAutoConnect: true });

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
        // Wallet-only. The post-login $OCCA token gate (see
        // shell/token-gate.tsx) checks the connected wallet's balance —
        // email login would mint a fresh empty embedded wallet that can
        // never clear the gate, so it's disabled. Users bring an
        // external wallet (Phantom / Solflare) that actually holds
        // $OCCA.
        loginMethods: ["wallet"],
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
