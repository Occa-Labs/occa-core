"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ListNotificationsResponse } from "@occa/shared/types";
import { notificationsApi } from "@/lib/api";
import { notificationKeys } from "./keys";

export function useReadAllNotifications() {
  const qc = useQueryClient();
  return useMutation<{ updated: number }, Error, void>({
    mutationFn: () => notificationsApi.readAll(),
    onSuccess: () => {
      const now = new Date().toISOString();
      qc.setQueriesData<ListNotificationsResponse | undefined>(
        { queryKey: notificationKeys.lists() },
        (prev) =>
          prev
            ? {
                ...prev,
                notifications: prev.notifications.map((n) =>
                  n.readAt ? n : { ...n, readAt: now },
                ),
                unreadCount: 0,
              }
            : prev,
      );
    },
  });
}
