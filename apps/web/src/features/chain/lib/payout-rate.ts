import type { AgentDTO } from "@occa/shared/types";
import {
  type PayoutAsset,
  SOL_PSEUDO_MINT_BASE58,
} from "@occa/shared/payout-assets";

// An active agent whose task rate in the company's ACTIVE payout asset is
// unset (null/0) produces no invoice when it completes a task — the billing
// service skips it silently (see invoice-on-task-complete.ts). This flags
// exactly that gap so the UI can remind the operator to set the rate.
export function agentMissingActiveRate(
  agent: AgentDTO,
  activeMint: string,
): boolean {
  if (agent.status !== "active") return false;
  const rate =
    activeMint === SOL_PSEUDO_MINT_BASE58
      ? agent.taskRateLamports
      : agent.taskRateUsdc;
  return rate === null || rate <= 0;
}

// Human symbol for the active mint ("SOL" / "USDC"), from the catalog with a
// mint-compare fallback so a missing catalog row never blanks the banner.
export function activeAssetSymbol(
  activeMint: string,
  assets: PayoutAsset[] | undefined,
): string {
  const hit = assets?.find((a) => a.mint === activeMint);
  if (hit) return hit.symbol;
  return activeMint === SOL_PSEUDO_MINT_BASE58 ? "SOL" : "USDC";
}
