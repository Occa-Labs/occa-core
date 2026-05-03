import * as ed from "@noble/ed25519";
import bs58 from "bs58";

/**
 * Verify a Solana wallet signed the given message.
 *
 * - `walletAddress`: base58-encoded Solana public key (32 bytes once decoded)
 * - `signature`: base58-encoded 64-byte ed25519 signature
 * - `message`: UTF-8 string that was signed (raw, unhashed — Solana
 *   wallet adapters sign the raw bytes of `signMessage(bytes)`).
 *
 * Returns true iff signature valid for the (message, publicKey) pair.
 */
export async function verifySolanaSignature(
  walletAddress: string,
  signature: string,
  message: string,
): Promise<boolean> {
  let pubkey: Uint8Array;
  let sig: Uint8Array;
  try {
    pubkey = bs58.decode(walletAddress);
    sig = bs58.decode(signature);
  } catch {
    return false;
  }
  if (pubkey.length !== 32 || sig.length !== 64) return false;

  const msgBytes = new TextEncoder().encode(message);
  try {
    return await ed.verifyAsync(sig, msgBytes, pubkey);
  } catch {
    return false;
  }
}
