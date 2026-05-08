"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TaskDTO } from "@occa/shared/types";
import { tasksApi } from "@/lib/api";
import { taskKeys } from "./keys";

export function useArchiveTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { id: string; reason?: string }) => {
      const { task } = await tasksApi.archive(input.id, {
        reason: input.reason,
      });
      return task;
    },
    onMutate: async (input) => {
      // Optimistic — drop the row from the active-list cache so the
      // archived task disappears from the board immediately.
      const activeKey = taskKeys.list({ includeArchived: false });
      await queryClient.cancelQueries({ queryKey: taskKeys.lists() });
      const previous = queryClient.getQueryData<TaskDTO[]>(activeKey);
      queryClient.setQueryData<TaskDTO[]>(activeKey, (old) =>
        (old ?? []).filter((t) => t.id !== input.id),
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
    onSettled: (_data, _err, vars) => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
      void queryClient.invalidateQueries({
        queryKey: taskKeys.events(vars.id),
      });
    },
  });
}
