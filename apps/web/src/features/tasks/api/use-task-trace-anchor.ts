"use client";

import { useQuery } from "@tanstack/react-query";
import { chainApi } from "@/lib/api";

// Reads the company's on-chain trace anchors so the task-detail journey can
// match the one belonging to this task. Uses the SAME query key as the Chain
// window's provenance list (["company-trace-anchors", companyId]) so an open
// Chain window and an open task panel share one cache entry — no double fetch.
// Cross-feature import of the Chain hook is forbidden by the web layer rules,
// so we re-declare the query here against the shared `chainApi` in lib.
export function useCompanyTraceAnchors(companyId: string, enabled = true) {
  return useQuery({
    queryKey: ["company-trace-anchors", companyId],
    queryFn: () => chainApi.getCompanyTraceAnchors(companyId),
    enabled,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
