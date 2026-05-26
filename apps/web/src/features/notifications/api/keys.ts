// Query key factory for notifications. One list query keyed by filter;
// detail-by-id intentionally absent (notifications are list-only on the
// FE, with optimistic mutations updating the list cache).

export const notificationKeys = {
  all: ["notifications"] as const,
  lists: () => [...notificationKeys.all, "list"] as const,
  list: (filter: { unread?: boolean }) =>
    [...notificationKeys.lists(), filter] as const,
};
