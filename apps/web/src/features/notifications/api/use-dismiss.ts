"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  ListNotificationsResponse,
  NotificationActionResponse,
} from "@occa/shared/types";
import { notificationsApi } from "@/lib/api";
import { notificationKeys } from "./keys";

export function useDismissNotification() {
  const qc = useQueryClient();
  return useMutation<NotificationActionResponse, Error, string>({
    mutationFn: (id: string) => notificationsApi.dismiss(id),
    onSuccess: (res) => {
      qc.setQueriesData<ListNotificationsResponse | undefined>(
        { queryKey: notificationKeys.lists() },
        (prev) =>
          prev
            ? {
                ...prev,
                notifications: prev.notifications.filter(
                  (n) => n.id !== res.notification.id,
                ),
                unreadCount: prev.notifications.some(
                  (n) => n.id === res.notification.id && n.readAt === null,
                )
                  ? Math.max(0, prev.unreadCount - 1)
                  : prev.unreadCount,
              }
            : prev,
      );
    },
  });
}
