"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { tasksApi } from "@/lib/api";
import { taskKeys } from "./keys";

export function useUnarchiveTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { task } = await tasksApi.unarchive(id);
      return task;
    },
    onSettled: (_data, _err, id) => {
      // Refetch both active + archived columns so the row reappears in the
      // active board and disappears from the archived view.
      void queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: taskKeys.counts() });
      void queryClient.invalidateQueries({ queryKey: taskKeys.events(id) });
    },
  });
}
