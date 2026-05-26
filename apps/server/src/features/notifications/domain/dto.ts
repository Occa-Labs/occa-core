import { notifications } from "@occa/shared/schema";
import type { NotificationDTO, NotificationKind } from "@occa/shared/types";

export function toNotificationDTO(
  row: typeof notifications.$inferSelect,
): NotificationDTO {
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId,
    kind: row.kind as NotificationKind,
    title: row.title,
    body: row.body ?? null,
    payload: (row.payload as Record<string, unknown>) ?? {},
    link: row.link ?? null,
    readAt: row.readAt?.toISOString() ?? null,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
