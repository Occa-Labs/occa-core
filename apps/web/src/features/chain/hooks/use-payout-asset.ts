"use client";

import { useQuery } from "@tanstack/react-query";
import { chainApi } from "@/lib/api";

// Company's active payout asset (SOL ↔ USDC) + the catalog. Shares the
// ["payout-asset", companyId] cache key with the treasury pane's toggle so
// both read the same single fetch.
export function usePayoutAsset(companyId: string | null | undefined) {
  return useQuery({
    queryKey: ["payout-asset", companyId],
    queryFn: () => chainApi.getPayoutAsset(companyId!),
    enabled: !!companyId,
  });
}
