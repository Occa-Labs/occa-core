"use client";

import { useQuery } from "@tanstack/react-query";
import { chainApi } from "@/lib/api";

export const companyTraceAnchorsKeys = {
  list: (companyId: string) => ["company-trace-anchors", companyId] as const,
};

export function useCompanyTraceAnchors(companyId: string, enabled = true) {
  return useQuery({
    queryKey: companyTraceAnchorsKeys.list(companyId),
    queryFn: () => chainApi.getCompanyTraceAnchors(companyId),
    enabled,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
