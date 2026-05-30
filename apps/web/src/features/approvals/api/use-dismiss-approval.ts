"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApprovalDTO } from "@occa/shared/types";
import { approvalsApi } from "@/lib/api";
import { approvalKeys } from "./keys";

export interface DismissApprovalInput {
  id: string;
}

// Clear a pending approval without an approve/reject decision. Mirrors
// useDecideApproval's optimistic idiom (drop from the pending list now,
// roll back on error, reconcile on settle) so dismiss feels identical to
// the other queue actions in this feature.
export function useDismissApproval() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: DismissApprovalInput) =>
      approvalsApi.dismiss(input.id),
    onMutate: async (input) => {
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
      void queryClient.invalidateQueries({ queryKey: approvalKeys.lists() });
    },
  });
}
