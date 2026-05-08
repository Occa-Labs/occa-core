"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TaskDTO, UpdateTaskRequest } from "@occa/shared/types";
import { tasksApi } from "@/lib/api";
import { taskKeys } from "./keys";

export function useUpdateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { id: string; patch: UpdateTaskRequest }) => {
      const { task } = await tasksApi.update(input.id, input.patch);
      return task;
    },
    onMutate: async (input) => {
      // Optimistic — apply patch to the cached active list so dropdowns
      // / inline edits feel instant. Tags is the one field that needs a
      // fallback when the patch doesn't include it. Archived list isn't
      // touched (rare path) — invalidate reconciles.
      const activeKey = taskKeys.list({ includeArchived: false });
      await queryClient.cancelQueries({ queryKey: taskKeys.lists() });
      const previous = queryClient.getQueryData<TaskDTO[]>(activeKey);
      queryClient.setQueryData<TaskDTO[]>(activeKey, (old) =>
        (old ?? []).map((t) =>
          t.id === input.id
            ? ({
                ...t,
                ...input.patch,
                tags: input.patch.tags ?? t.tags,
              } as TaskDTO)
            : t,
        ),
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(
          taskKeys.list({ includeArchived: false }),
          ctx.previous,
        );
      }
    },
    onSuccess: (task) => {
      queryClient.setQueryData<TaskDTO[]>(
        taskKeys.list({ includeArchived: false }),
        (old) => (old ?? []).map((t) => (t.id === task.id ? task : t)),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
    },
  });
}
