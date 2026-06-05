"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
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
    onSettled: (_data, _err, vars) => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: taskKeys.counts() });
      void queryClient.invalidateQueries({ queryKey: taskKeys.events(vars.id) });
    },
  });
}
