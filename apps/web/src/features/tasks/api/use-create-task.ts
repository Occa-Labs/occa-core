"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateTaskRequest } from "@occa/shared/types";
import { tasksApi } from "@/lib/api";
import { taskKeys } from "./keys";

export function useCreateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateTaskRequest) => {
      const { task } = await tasksApi.create(input);
      return task;
    },
    // Per-column infinite queries replaced the flat cache, so invalidate the
    // columns + counts and let the relevant column refetch its first page —
    // the new task lands at the top of its status column.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: taskKeys.counts() });
    },
  });
}
