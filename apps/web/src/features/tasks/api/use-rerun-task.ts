"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { tasksApi } from "@/lib/api";
import { taskKeys } from "./keys";

export function useRerunTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { task } = await tasksApi.rerun(id);
      return task;
    },
    onSettled: () => {
      // Status flips to in_progress on the server side after enqueue —
      // refetch so the board reflects it immediately rather than waiting
      // for the next poll.
      void queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: taskKeys.counts() });
    },
  });
}
