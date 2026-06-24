// Network-resolved payout asset catalog.
//
// Composes the network-agnostic metadata from `@occa/shared/payout-assets`
// with the network-specific SPL mint(s) from env, producing the closed set
// of assets a company may pay in. The chain routes serve this to the UI so
// the web never hardcodes a mint, and validate a company's chosen
// `payout_mint` against it.

import {
  PAYOUT_ASSET_META,
  SOL_PSEUDO_MINT_BASE58,
  type PayoutAsset,
} from "@occa/shared/payout-assets";
import { env } from "../../../config/env";

/**
 * The payout assets supported on the active network. SOL is always present
 * (its mint is the fixed pseudo-mint); USDC's mint comes from
 * `OCCA_USDC_MINT` so devnet and mainnet resolve to the right token.
 */
export function resolvePayoutAssets(): PayoutAsset[] {
  return [
    { ...PAYOUT_ASSET_META.SOL, mint: SOL_PSEUDO_MINT_BASE58 },
    { ...PAYOUT_ASSET_META.USDC, mint: env.OCCA_USDC_MINT },
  ];
}

/** Find a supported asset by its base58 mint, or undefined if unsupported. */
export function findPayoutAssetByMint(mint: string): PayoutAsset | undefined {
  return resolvePayoutAssets().find((a) => a.mint === mint);
}
