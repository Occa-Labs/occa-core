"use client";

import { useQuery } from "@tanstack/react-query";
import { chainApi } from "@/lib/api";

export const companyAnchorsKeys = {
  list: (companyId: string) => ["company-anchors", companyId] as const,
};

export function useCompanyAnchors(companyId: string, enabled = true) {
  return useQuery({
    queryKey: companyAnchorsKeys.list(companyId),
    queryFn: () => chainApi.getCompanyAnchors(companyId),
    enabled,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
