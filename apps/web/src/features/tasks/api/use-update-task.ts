"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UpdateTaskRequest } from "@occa/shared/types";
import { tasksApi } from "@/lib/api";
import { taskKeys } from "./keys";

export function useUpdateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { id: string; patch: UpdateTaskRequest }) => {
      const { task } = await tasksApi.update(input.id, input.patch);
      return task;
    },
    // Optimistic updates were dropped when the board moved to per-column
    // infinite queries (the old flat-array cache no longer exists). Instead
    // invalidate the columns + counts — the affected column refetches one
    // 50-row page, fast enough to feel immediate.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: taskKeys.counts() });
    },
  });
}
