// Nonce lifecycle rules. Pure — no DB, no HTTP.

export const NONCE_TTL_MS = 5 * 60 * 1000;

export function buildSignMessage(
  walletAddress: string,
  nonce: string,
  expiresAt: Date,
): string {
  return [
    "OCCA Sign-in",
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
  ].join("\n");
}
