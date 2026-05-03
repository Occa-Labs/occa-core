"use client";

import { useCallback, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ApprovalDTO } from "@occa/shared/types";
import { ApiError, approvalsApi } from "@/lib/api";

export interface UseApprovalsResult {
  approvals: ApprovalDTO[];
  loading: boolean;
  error: string | null;
  decide: (
    id: string,
    decision: "approve" | "reject",
    rejectionReason?: string,
  ) => Promise<boolean>;
  reload: () => Promise<void>;
}

function extractError(err: unknown): string {
  if (err instanceof ApiError) {
    if (
      err.body &&
      typeof err.body === "object" &&
      "error" in err.body &&
      typeof (err.body as Record<string, unknown>).error === "string"
    ) {
      return (err.body as { error: string }).error;
    }
    return `api_${err.status}`;
  }
  return err instanceof Error ? err.message : "failed";
}

export const APPROVALS_QUERY_KEY = ["approvals", "pending"] as const;

// 15s — was 3s in the legacy setInterval impl. Notification badge doesn't
// need sub-5s freshness, and decide() triggers an immediate invalidate so
// the UI reflects user actions instantly regardless of the poll cadence.
const REFETCH_INTERVAL_MS = 15_000;

export function useApprovals(enabled: boolean): UseApprovalsResult {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: APPROVALS_QUERY_KEY,
    queryFn: async () => {
      const { approvals } = await approvalsApi.list({ status: "pending" });
      return approvals;
    },
    enabled,
    refetchInterval: REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });

  // Local error state — survives transient mutation errors that we don't
  // want to overwrite the query.error (e.g. failed decide() shouldn't
  // claim the LIST is broken).
  const [mutationError, setMutationError] = useState<string | null>(null);

  const decideMutation = useMutation({
    mutationFn: async (input: {
      id: string;
      decision: "approve" | "reject";
      rejectionReason?: string;
    }) => approvalsApi.decide(input.id, input.decision, input.rejectionReason),
    onMutate: async (input) => {
      // Optimistic — drop from pending list immediately.
      await queryClient.cancelQueries({ queryKey: APPROVALS_QUERY_KEY });
      const previous =
        queryClient.getQueryData<ApprovalDTO[]>(APPROVALS_QUERY_KEY);
      queryClient.setQueryData<ApprovalDTO[]>(APPROVALS_QUERY_KEY, (old) =>
        (old ?? []).filter((a) => a.id !== input.id),
      );
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      // Restore snapshot if server rejected the decision.
      if (ctx?.previous) {
        queryClient.setQueryData(APPROVALS_QUERY_KEY, ctx.previous);
      }
      setMutationError(extractError(err));
    },
    onSettled: () => {
      // Refetch to reconcile with server (covers the case where another
      // operator decided concurrently).
      void queryClient.invalidateQueries({ queryKey: APPROVALS_QUERY_KEY });
    },
  });

  const decide = useCallback<UseApprovalsResult["decide"]>(
    async (id, decision, rejectionReason) => {
      setMutationError(null);
      try {
        await decideMutation.mutateAsync({ id, decision, rejectionReason });
        return true;
      } catch {
        return false;
      }
    },
    [decideMutation],
  );

  const reload = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: APPROVALS_QUERY_KEY });
  }, [queryClient]);

  const queryError = query.isError ? extractError(query.error) : null;

  return {
    approvals: query.data ?? [],
    loading: query.isPending && enabled,
    error: queryError ?? mutationError,
    decide,
    reload,
  };
}
