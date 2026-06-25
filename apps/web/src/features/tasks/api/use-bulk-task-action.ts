"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { tasksApi } from "@/lib/api";
import { taskKeys } from "./keys";

/**
 * Bulk archive or delete every task in a board column (by status). One call
 * hits the server-side filter, so it covers cards not yet paged into the
 * client. Invalidates lists + counts so the board reflects the result.
 *
 * `status` accepts a real TaskStatus or the pseudo-status "attention" (the
 * combined blocked + error column).
 */
export function useBulkTaskAction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      action: "archive" | "delete";
      status: string;
    }) => {
      return tasksApi.bulk(input);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: taskKeys.counts() });
    },
  });
}
