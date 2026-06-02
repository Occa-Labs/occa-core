"use client";

import { cn } from "@/lib/utils";
import { SOLANA_CLUSTER, type SolanaCluster } from "@/lib/env-flags";

// Tiny inline label that surfaces which Solana cluster the OS is
// pointing at. Sits in the top-menu-bar next to FPS / view-mode /
// notifications / wallet so it reads as just another status item.
// Plain text only — no colored status dot, on purpose, so the bar
// stays calm.

interface ChainBadgeProps {
  className?: string;
}

const LABEL: Record<SolanaCluster, string> = {
  "mainnet-beta": "Mainnet",
  devnet: "Devnet",
  testnet: "Testnet",
  localnet: "Localnet",
};

export function ChainBadge({ className }: ChainBadgeProps) {
  const cluster = SOLANA_CLUSTER;
  return (
    <div
      className={cn(
        "inline-flex items-center text-xs font-light text-white/55",
        className,
      )}
      title={`Solana ${LABEL[cluster]}`}
      aria-label={`Solana ${LABEL[cluster]}`}
    >
      Network {LABEL[cluster]}
    </div>
  );
}
