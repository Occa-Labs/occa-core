"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentDTO, CompanyDTO, MeResponse } from "@occa/shared/types";
import { ApiError, meApi } from "@/lib/api";

export interface UseMeResult {
  company: CompanyDTO | null;
  agents: AgentDTO[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export const ME_QUERY_KEY = ["me"] as const;

export function useMe(enabled: boolean): UseMeResult {
  const queryClient = useQueryClient();

  const query = useQuery<MeResponse>({
    queryKey: ME_QUERY_KEY,
    queryFn: meApi.get,
    enabled,
    refetchInterval: 10_000,
    refetchOnWindowFocus: false,
    staleTime: 10_000,
  });

  // Stable reload — invalidates the cache, triggers refetch. Used by
  // mutations (kickoff start, agent CRUD) that need fresh me state.
  const reload = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  }, [queryClient]);

  let error: string | null = null;
  if (query.isError) {
    const err = query.error;
    error = err instanceof ApiError ? `api_${err.status}` : "network_error";
  }

  const data = query.data;
  return {
    company: (data?.company as CompanyDTO | null) ?? null,
    agents: (data?.agents as AgentDTO[]) ?? [],
    loading: query.isPending && enabled,
    error,
    reload,
  };
}
