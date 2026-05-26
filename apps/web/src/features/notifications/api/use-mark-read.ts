"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  ListNotificationsResponse,
  NotificationActionResponse,
} from "@occa/shared/types";
import { notificationsApi } from "@/lib/api";
import { notificationKeys } from "./keys";

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation<NotificationActionResponse, Error, string>({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: (res) => {
      // Patch every list cache so the unread badge updates without a
      // round-trip. Both filter variants (unread / all) are touched.
      qc.setQueriesData<ListNotificationsResponse | undefined>(
        { queryKey: notificationKeys.lists() },
        (prev) =>
          prev
            ? {
                ...prev,
                notifications: prev.notifications.map((n) =>
                  n.id === res.notification.id ? res.notification : n,
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
