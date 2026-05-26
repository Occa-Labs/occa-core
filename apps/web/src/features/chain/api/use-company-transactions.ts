"use client";

import { useQuery } from "@tanstack/react-query";
import { chainApi } from "@/lib/api";

export const companyTransactionsKeys = {
  list: (companyId: string, before: string | null) =>
    ["company-transactions", companyId, before ?? "head"] as const,
};

export function useCompanyTransactions(
  companyId: string,
  options: { limit?: number; before?: string | null; enabled?: boolean } = {},
) {
  const { limit = 25, before = null, enabled = true } = options;
  return useQuery({
    queryKey: companyTransactionsKeys.list(companyId, before),
    queryFn: () =>
      chainApi.getCompanyTransactions(companyId, {
        limit,
        before: before ?? undefined,
      }),
    enabled,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
