"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApprovalDTO } from "@occa/shared/types";
import { approvalsApi } from "@/lib/api";
import { approvalKeys } from "./keys";

export interface DecideApprovalInput {
  id: string;
  decision: "approve" | "reject";
  rejectionReason?: string;
}

export function useDecideApproval() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: DecideApprovalInput) =>
      approvalsApi.decide(input.id, input.decision, input.rejectionReason),
    onMutate: async (input) => {
      // Optimistic — drop from pending list immediately.
      const pendingKey = approvalKeys.list({ status: "pending" });
      await queryClient.cancelQueries({ queryKey: approvalKeys.lists() });
      const previous = queryClient.getQueryData<ApprovalDTO[]>(pendingKey);
      queryClient.setQueryData<ApprovalDTO[]>(pendingKey, (old) =>
        (old ?? []).filter((a) => a.id !== input.id),
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(
          approvalKeys.list({ status: "pending" }),
          ctx.previous,
        );
      }
    },
    onSettled: () => {
      // Reconcile: re-fetch pending + any history list the user may be on.
      void queryClient.invalidateQueries({ queryKey: approvalKeys.lists() });
    },
  });
}
