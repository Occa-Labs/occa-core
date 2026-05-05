import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

let cached: Keypair | null = null;

/**
 * Operator hot wallet. Fee-payer ONLY for on-chain registry instructions
 * (`create_company`, `register_agent`, `set_operating_wallet`). Never an
 * authority on any account — every state-changing ix is signed by the
 * user wallet (`owner`) in the browser; the operator just partial-signs
 * the tx server-side so the user doesn't need SOL to onboard.
 *
 * Set `OCCA_OPERATOR_SECRET_KEY` to a base58-encoded 64-byte secretKey
 * (output of `solana-keygen` / Phantom export). Throws if missing —
 * chain routes are the only callers, and they should fail loudly when
 * misconfigured.
 */
export function getOperatorKeypair(): Keypair {
  if (cached) return cached;
  const raw = process.env.OCCA_OPERATOR_SECRET_KEY?.trim();
  if (!raw) {
    throw new Error(
      "OCCA_OPERATOR_SECRET_KEY is not set — required for on-chain registration",
    );
  }
  let secret: Uint8Array;
  try {
    secret = bs58.decode(raw);
  } catch (err) {
    throw new Error(
      `OCCA_OPERATOR_SECRET_KEY is not valid base58: ${(err as Error).message}`,
    );
  }
  if (secret.length !== 64) {
    throw new Error(
      `OCCA_OPERATOR_SECRET_KEY must decode to 64 bytes, got ${secret.length}`,
    );
  }
  cached = Keypair.fromSecretKey(secret);
  return cached;
}
