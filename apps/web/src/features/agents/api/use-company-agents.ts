"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentDTO } from "@occa/shared/types";
import { agentsApi } from "@/lib/api";

export interface UseCompanyAgentsResult {
  agents: AgentDTO[];
  loading: boolean;
  reload: () => Promise<void>;
}

export const COMPANY_AGENTS_QUERY_KEY = ["company-agents"] as const;

// The company-scoped agent list — every deployment at the caller's company,
// INCLUDING cross-owner agents (owned by another user but deployed here).
// The company OS reads this instead of `/api/me` (owner-scoped) so hired
// agents from the marketplace actually show up in the office.
export function useCompanyAgents(enabled: boolean): UseCompanyAgentsResult {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: COMPANY_AGENTS_QUERY_KEY,
    queryFn: agentsApi.list,
    enabled,
    refetchInterval: 10_000,
    refetchOnWindowFocus: false,
    staleTime: 10_000,
  });

  const reload = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: COMPANY_AGENTS_QUERY_KEY });
  }, [queryClient]);

  return {
    agents: query.data?.agents ?? [],
    loading: query.isPending && enabled,
    reload,
  };
}
