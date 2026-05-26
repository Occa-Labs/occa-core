import { and, count, desc, eq, isNull } from "drizzle-orm";
import { notifications } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { LIMITS } from "../../../lib/limits";

export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationInsert = typeof notifications.$inferInsert;

export async function listForUser(
  userId: string,
  opts: { unread?: boolean; limit?: number } = {},
): Promise<NotificationRow[]> {
  const conditions = [eq(notifications.userId, userId)];
  if (opts.unread) conditions.push(isNull(notifications.readAt));
  return db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(opts.limit ?? LIMITS.PAGINATION_DEFAULT);
}

export async function unreadCountForUser(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(notifications)
    .where(
      and(eq(notifications.userId, userId), isNull(notifications.readAt)),
    );
  return Number(row?.n ?? 0);
}

export async function findByIdForUser(
  id: string,
  userId: string,
): Promise<NotificationRow | null> {
  const [row] = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function markRead(id: string): Promise<NotificationRow> {
  const [row] = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(eq(notifications.id, id))
    .returning();
  return row;
}

export async function dismiss(id: string): Promise<NotificationRow> {
  const [row] = await db
    .update(notifications)
    .set({
      readAt: new Date(),
      dismissedAt: new Date(),
    })
    .where(eq(notifications.id, id))
    .returning();
  return row;
}

export async function markAllReadForUser(userId: string): Promise<number> {
  const result = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(eq(notifications.userId, userId), isNull(notifications.readAt)),
    )
    .returning({ id: notifications.id });
  return result.length;
}

export async function insertOne(
  row: NotificationInsert,
): Promise<NotificationRow> {
  const [inserted] = await db.insert(notifications).values(row).returning();
  return inserted;
}
