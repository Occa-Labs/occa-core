"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateTaskRequest, TaskDTO } from "@occa/shared/types";
import { tasksApi } from "@/lib/api";
import { taskKeys } from "./keys";

export function useCreateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateTaskRequest) => {
      const { task } = await tasksApi.create(input);
      return task;
    },
    onSuccess: (task) => {
      // Splice in immediately so the new task appears on top without
      // waiting for the next poll. Active-list cache only — archived view
      // gets reconciled by the prefix invalidate below.
      queryClient.setQueryData<TaskDTO[]>(
        taskKeys.list({ includeArchived: false }),
        (old) => (old ? [task, ...old] : [task]),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
    },
  });
}
