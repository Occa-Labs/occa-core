// Drizzle access for the per-(company, deployment) chat thread. One row
// per turn — user prompt + CEO reply land as separate rows so the UI
// renders them as distinct bubbles.

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { approvals, chatMessages } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type ChatMessageInsert = typeof chatMessages.$inferInsert;

// Minimal approval slice for the inline chat card. Reading the approvals
// table here (not importing the approvals feature) keeps the no-cross-
// feature-import rule intact — the table lives in the shared schema.
export interface LinkedApprovalRow {
  id: string;
  actionType: string;
  payload: Record<string, unknown> | null;
  status: string;
}

// Fetch the approvals referenced by a batch of messages' linkedApprovalId,
// keyed by id. Empty input short-circuits (no query).
export async function findLinkedApprovals(
  ids: string[],
): Promise<Map<string, LinkedApprovalRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: approvals.id,
      actionType: approvals.actionType,
      payload: approvals.payload,
      status: approvals.status,
    })
    .from(approvals)
    .where(inArray(approvals.id, ids));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        actionType: r.actionType,
        payload: (r.payload ?? null) as Record<string, unknown> | null,
        status: r.status,
      },
    ]),
  );
}

export async function listMessages(args: {
  companyId: string;
  deploymentId: string;
  // Scope to one session (thread reset_generation). The active chat passes
  // the thread's current generation; History passes a prior one. Omitted =
  // all generations (used by the read-only inbox view).
  generation?: number;
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
        args.generation === undefined
          ? undefined
          : eq(chatMessages.resetGeneration, args.generation),
      ),
    )
    .orderBy(asc(chatMessages.createdAt))
    .limit(args.limit ?? 200);
}

export interface ChatSessionRow {
  generation: number;
  messageCount: number;
  startedAt: string;
  lastAt: string;
}

// One row per session (reset_generation) that has messages, newest first.
// Drives the History dropdown — each prior session is browsable read-only.
export async function listSessions(args: {
  companyId: string;
  deploymentId: string;
}): Promise<ChatSessionRow[]> {
  const rows = await db
    .select({
      generation: chatMessages.resetGeneration,
      messageCount: sql<number>`count(*)::int`,
      startedAt: sql<string>`min(${chatMessages.createdAt})`,
      lastAt: sql<string>`max(${chatMessages.createdAt})`,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.companyId, args.companyId),
        eq(chatMessages.deploymentId, args.deploymentId),
      ),
    )
    .groupBy(chatMessages.resetGeneration)
    .orderBy(desc(chatMessages.resetGeneration));
  return rows.map((r) => ({
    generation: r.generation,
    messageCount: r.messageCount,
    startedAt: new Date(r.startedAt).toISOString(),
    lastAt: new Date(r.lastAt).toISOString(),
  }));
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

// NOTE: there is no destructive "clear" anymore. "New session" bumps the
// thread's reset_generation (chat-threads.bumpThreadResetGeneration) so the
// active chat moves to a fresh, empty generation while prior messages stay
// tagged with their old generation for History. The adapter session is reset
// separately via adapter.resetSession.

