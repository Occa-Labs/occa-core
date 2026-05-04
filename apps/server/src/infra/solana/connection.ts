import { Connection } from "@solana/web3.js";

const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
const DEFAULT_COMMITMENT = "confirmed" as const;

let cached: Connection | null = null;

/**
 * Singleton Solana RPC connection. Reads `SOLANA_RPC_URL` from env;
 * defaults to devnet (matches deployed Registry program).
 */
export function getConnection(): Connection {
  if (cached) return cached;
  const url = process.env.SOLANA_RPC_URL?.trim() || DEFAULT_RPC_URL;
  cached = new Connection(url, DEFAULT_COMMITMENT);
  return cached;
}
