import { SOLANA_CLUSTER, type SolanaCluster } from "./env-flags";

// Block-explorer URL builders. Read the active cluster once at module
// init; all callers stay synchronous and don't need to know which env
// they're in. Localnet has no public explorer presence — we still build
// URLs (mapped to devnet) so dev links don't 404 the whole UI.

type ClusterParam = "mainnet" | "devnet" | "testnet";

function clusterParam(c: SolanaCluster): ClusterParam {
  if (c === "mainnet-beta") return "mainnet";
  if (c === "testnet") return "testnet";
  // devnet + localnet both map to devnet for explorer querystrings.
  return "devnet";
}

const CP = clusterParam(SOLANA_CLUSTER);

// Solscan — only appends `?cluster=` for non-mainnet so mainnet URLs
// stay clean and shareable.
function solscanQS(): string {
  return CP === "mainnet" ? "" : `?cluster=${CP}`;
}

export function solscanAddressUrl(address: string): string {
  return `https://solscan.io/account/${address}${solscanQS()}`;
}

export function solscanTxUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}${solscanQS()}`;
}

// Solana Explorer (official). Always carries the cluster param.
function explorerQS(): string {
  return CP === "mainnet" ? "" : `?cluster=${CP}`;
}

export function explorerAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}${explorerQS()}`;
}

export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}${explorerQS()}`;
}

// Truncate a base58 address / signature for display: "Abc1…xYz9".
export function shortenAddress(addr: string, head = 4, tail = 4): string {
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

// Human label for the active cluster — used in status pills.
export const CLUSTER_LABEL: string =
  SOLANA_CLUSTER === "mainnet-beta"
    ? "Solana mainnet"
    : SOLANA_CLUSTER === "testnet"
      ? "Solana testnet"
      : SOLANA_CLUSTER === "localnet"
        ? "Solana localnet"
        : "Solana devnet";
