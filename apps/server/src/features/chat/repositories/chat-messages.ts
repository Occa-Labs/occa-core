// Drizzle access for the per-(company, deployment) chat thread. One row
// per turn — user prompt + CEO reply land as separate rows so the UI
// renders them as distinct bubbles.

import { and, asc, eq } from "drizzle-orm";
import { chatMessages } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type ChatMessageInsert = typeof chatMessages.$inferInsert;

export async function listMessages(args: {
  companyId: string;
  deploymentId: string;
  limit?: number;
}): Promise<ChatMessageRow[]> {
  // No pagination cursor yet — the chat is bounded per-deployment and we
  // expect order-of-magnitude hundreds of messages, not millions. Cap at
  // `limit` (default 200) to keep the payload reasonable.
  return db
    .select()
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.companyId, args.companyId),
        eq(chatMessages.deploymentId, args.deploymentId),
      ),
    )
    .orderBy(asc(chatMessages.createdAt))
    .limit(args.limit ?? 200);
}

export async function insertMessage(
  values: ChatMessageInsert,
): Promise<ChatMessageRow> {
  const [row] = await db.insert(chatMessages).values(values).returning();
  return row;
}

// Returns the earliest message id for the thread. Used as the gateway
// sessionKey boundary marker — stable across turns, changes only when
// the thread is cleared.
export async function earliestMessageId(args: {
  companyId: string;
  deploymentId: string;
}): Promise<string | null> {
  const [row] = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.companyId, args.companyId),
        eq(chatMessages.deploymentId, args.deploymentId),
      ),
    )
    .orderBy(asc(chatMessages.createdAt))
    .limit(1);
  return row?.id ?? null;
}

// Wipe the entire chat thread. The next user message will start with a
// fresh gateway sessionKey (because the boundary marker changes), so
// the CEO has no memory of prior turns either.
export async function clearThread(args: {
  companyId: string;
  deploymentId: string;
}): Promise<void> {
  await db
    .delete(chatMessages)
    .where(
      and(
        eq(chatMessages.companyId, args.companyId),
        eq(chatMessages.deploymentId, args.deploymentId),
      ),
    );
}

