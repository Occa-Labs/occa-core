"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanyToolDTO,
  InstallCompanyToolRequest,
  ToolCallLogDTO,
  ToolCatalogEntry,
  ToolTestConnectionResult,
  UpdateCompanyToolRequest,
} from "@occa/shared/types";
import { ApiError, toolsApi } from "@/lib/api";

// Query keys factory keeps cache slicing consistent across screens.
const keys = {
  catalog: () => ["tools", "catalog"] as const,
  list: (companyId: string) => ["tools", "list", companyId] as const,
  logs: (companyId: string, toolId: string) =>
    ["tools", "logs", companyId, toolId] as const,
};

export interface UseToolCatalogResult {
  tools: ToolCatalogEntry[];
  loading: boolean;
  error: string | null;
}

export function useToolCatalog(enabled = true): UseToolCatalogResult {
  const query = useQuery({
    queryKey: keys.catalog(),
    queryFn: () => toolsApi.catalog(),
    enabled,
  });
  return {
    tools: query.data?.tools ?? [],
    loading: query.isLoading,
    error: query.error
      ? query.error instanceof ApiError
        ? `api_${query.error.status}`
        : "network_error"
      : null,
  };
}

export interface UseCompanyToolsResult {
  tools: CompanyToolDTO[];
  loading: boolean;
  error: string | null;
  install: (input: InstallCompanyToolRequest) => Promise<{
    tool: CompanyToolDTO;
    testConnection?: ToolTestConnectionResult;
  }>;
  patch: (
    toolId: string,
    input: UpdateCompanyToolRequest,
  ) => Promise<CompanyToolDTO>;
  remove: (toolId: string) => Promise<void>;
  test: (toolId: string) => Promise<ToolTestConnectionResult>;
  reload: () => Promise<void>;
}

export function useCompanyTools(
  companyId: string | null,
  enabled = true,
): UseCompanyToolsResult {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: companyId ? keys.list(companyId) : ["tools", "list", "_none"],
    queryFn: () => (companyId ? toolsApi.list(companyId) : Promise.resolve({ tools: [] })),
    enabled: enabled && Boolean(companyId),
  });

  const invalidate = useCallback(async () => {
    if (!companyId) return;
    await qc.invalidateQueries({ queryKey: keys.list(companyId) });
  }, [qc, companyId]);

  const install = useCallback(
    async (input: InstallCompanyToolRequest) => {
      if (!companyId) throw new Error("no company");
      const res = await toolsApi.install(companyId, input);
      await invalidate();
      return res;
    },
    [companyId, invalidate],
  );

  const patch = useCallback(
    async (toolId: string, input: UpdateCompanyToolRequest) => {
      if (!companyId) throw new Error("no company");
      const res = await toolsApi.patch(companyId, toolId, input);
      await invalidate();
      return res.tool;
    },
    [companyId, invalidate],
  );

  const remove = useCallback(
    async (toolId: string) => {
      if (!companyId) throw new Error("no company");
      await toolsApi.remove(companyId, toolId);
      await invalidate();
    },
    [companyId, invalidate],
  );

  const test = useCallback(
    async (toolId: string) => {
      if (!companyId) throw new Error("no company");
      const res = await toolsApi.test(companyId, toolId);
      return res.result;
    },
    [companyId],
  );

  return {
    tools: query.data?.tools ?? [],
    loading: query.isLoading,
    error: query.error
      ? query.error instanceof ApiError
        ? `api_${query.error.status}`
        : "network_error"
      : null,
    install,
    patch,
    remove,
    test,
    reload: invalidate,
  };
}

export interface UseToolLogsResult {
  logs: ToolCallLogDTO[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useToolLogs(args: {
  companyId: string | null;
  toolId: string | null;
  enabled?: boolean;
  limit?: number;
}): UseToolLogsResult {
  const qc = useQueryClient();
  const canQuery = Boolean(args.companyId && args.toolId);
  const query = useQuery({
    queryKey:
      args.companyId && args.toolId
        ? keys.logs(args.companyId, args.toolId)
        : ["tools", "logs", "_none"],
    queryFn: () =>
      args.companyId && args.toolId
        ? toolsApi.logs(args.companyId, args.toolId, { limit: args.limit })
        : Promise.resolve({ logs: [] }),
    enabled: canQuery && (args.enabled ?? true),
  });
  return {
    logs: query.data?.logs ?? [],
    loading: query.isLoading,
    error: query.error
      ? query.error instanceof ApiError
        ? `api_${query.error.status}`
        : "network_error"
      : null,
    reload: async () => {
      if (!args.companyId || !args.toolId) return;
      await qc.invalidateQueries({
        queryKey: keys.logs(args.companyId, args.toolId),
      });
    },
  };
}
