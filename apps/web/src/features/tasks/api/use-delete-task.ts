"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TaskDTO } from "@occa/shared/types";
import { tasksApi } from "@/lib/api";
import { taskKeys } from "./keys";

export function useDeleteTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      await tasksApi.remove(id);
      return id;
    },
    onMutate: async (id) => {
      const activeKey = taskKeys.list({ includeArchived: false });
      await queryClient.cancelQueries({ queryKey: taskKeys.lists() });
      const previous = queryClient.getQueryData<TaskDTO[]>(activeKey);
      queryClient.setQueryData<TaskDTO[]>(activeKey, (old) =>
        (old ?? []).filter((t) => t.id !== id),
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
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
    },
  });
}
