"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TaskCommentDTO } from "@occa/shared/types";
import { tasksApi } from "@/lib/api";
import { taskKeys } from "./keys";

export function useCreateTaskComment(taskId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: string) => {
      const { comment } = await tasksApi.addComment(taskId, { body });
      return comment;
    },
    onSuccess: (comment) => {
      // Append to the cached thread so the new comment shows up before
      // the next 3s poll. Server may also wake an @mentioned agent,
      // whose reply will land via the polling refetch.
      queryClient.setQueryData<TaskCommentDTO[]>(
        taskKeys.comments(taskId),
        (old) => (old ? [...old, comment] : [comment]),
      );
    },
    onSettled: () => {
      // Reconcile + bring in any agent replies that were posted
      // between optimistic insert and now.
      void queryClient.invalidateQueries({
        queryKey: taskKeys.comments(taskId),
      });
      // Comment-added events show up in the timeline.
      void queryClient.invalidateQueries({
        queryKey: taskKeys.events(taskId),
      });
    },
  });
}
