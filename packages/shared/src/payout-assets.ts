// Payout asset catalog — the assets a company can disburse in.
//
// A company pays in exactly one asset at a time (its `payout_mint`); this
// catalog is the small, closed set the toggle chooses between. The treasury
// program is per-mint generic, so adding an asset is config, not a program
// change.
//
// Split of concerns:
//   • This file holds the NETWORK-AGNOSTIC metadata (key, symbol, decimals)
//     plus the fixed SOL pseudo-mint. It is safe to import on web + server.
//   • The actual SPL mint addresses are NETWORK-SPECIFIC (devnet USDC ≠
//     mainnet USDC), so the server resolves them from env and composes the
//     full `PayoutAsset` list the UI consumes. The web never hardcodes a
//     mint — it reads the resolved list from the API.

/** Base58 of the all-zero pubkey — the SOL pseudo-mint used on-chain. */
export const SOL_PSEUDO_MINT_BASE58 = "11111111111111111111111111111111";

export type PayoutAssetKey = "SOL" | "USDC";

/** Network-agnostic display + math metadata for a payout asset. */
export interface PayoutAssetMeta {
  key: PayoutAssetKey;
  symbol: string;
  /** Base-unit exponent: SOL lamports = 9, USDC micro-units = 6. */
  decimals: number;
}

export const PAYOUT_ASSET_META: Record<PayoutAssetKey, PayoutAssetMeta> = {
  SOL: { key: "SOL", symbol: "SOL", decimals: 9 },
  USDC: { key: "USDC", symbol: "USDC", decimals: 6 },
};

/** A payout asset resolved for a specific network — mint included. */
export interface PayoutAsset extends PayoutAssetMeta {
  /** Base58 mint. All-zero pubkey for SOL, an SPL mint otherwise. */
  mint: string;
}

/** True for the SOL pseudo-mint. */
export function isSolMint(mint: string): boolean {
  return mint === SOL_PSEUDO_MINT_BASE58;
}

/**
 * Format a base-unit integer amount into a human decimal string for an
 * asset. `123450000` at 6 decimals → "123.45". Trailing zeros are trimmed;
 * a whole number renders without a fractional part. Amounts are DB
 * `number`-mode (well within safe-integer range for realistic payouts), so
 * plain number math is used — no BigInt.
 */
export function formatAssetAmount(baseUnits: number, decimals: number): string {
  const divisor = 10 ** decimals;
  const whole = Math.floor(baseUnits / divisor);
  const frac = baseUnits - whole * divisor;
  if (frac === 0) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}
