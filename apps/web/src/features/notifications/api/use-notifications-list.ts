"use client";

import { useQuery } from "@tanstack/react-query";
import type { ListNotificationsResponse } from "@occa/shared/types";
import { notificationsApi } from "@/lib/api";
import { notificationKeys } from "./keys";

const REFETCH_INTERVAL_MS = 15_000;

export function useNotificationsList(enabled: boolean, unread = false) {
  return useQuery({
    queryKey: notificationKeys.list({ unread }),
    queryFn: async (): Promise<ListNotificationsResponse> =>
      notificationsApi.list({ unread, limit: 100 }),
    enabled,
    refetchInterval: REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });
}
