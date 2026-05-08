"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApprovalDTO } from "@occa/shared/types";
import { approvalsApi, type ApprovalEditablePayload } from "@/lib/api";
import { approvalKeys } from "./keys";

export interface UpdateApprovalInput {
  id: string;
  payload: ApprovalEditablePayload;
}

export function useUpdateApproval() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateApprovalInput) =>
      (await approvalsApi.patch(input.id, input.payload)).approval,
    onMutate: async (input) => {
      // Optimistic merge into the pending list so the form reflects the
      // edit immediately. Original payload snapshot is server-side only.
      const pendingKey = approvalKeys.list({ status: "pending" });
      await queryClient.cancelQueries({ queryKey: approvalKeys.lists() });
      const previous = queryClient.getQueryData<ApprovalDTO[]>(pendingKey);
      queryClient.setQueryData<ApprovalDTO[]>(pendingKey, (old) =>
        (old ?? []).map((a) =>
          a.id === input.id
            ? {
                ...a,
                payload: {
                  ...(a.payload as Record<string, unknown>),
                  ...input.payload,
                },
              }
            : a,
        ),
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
    onSuccess: (approval) => {
      // Replace with server-truth (includes originalPayload snapshot,
      // editedAt timestamp, etc.).
      queryClient.setQueryData<ApprovalDTO[]>(
        approvalKeys.list({ status: "pending" }),
        (old) => (old ?? []).map((a) => (a.id === approval.id ? approval : a)),
      );
    },
  });
}
