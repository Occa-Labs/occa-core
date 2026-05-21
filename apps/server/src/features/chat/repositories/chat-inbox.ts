// Read-only inbox view across the chat surface — powers the OS "Chats"
// window. Two query shapes:
//
//   • partners-for-self : given a viewer (the auth user, or one of their
//     deployments), list the distinct counterparts they have ever talked
//     to, with a single latest-message summary per counterpart. Threads
//     that share the same (self, partner) pair are collapsed.
//
//   • messages-between : given a (self, partner) pair, return every
//     message across every shared thread, in chronological order, with
//     each row stamped with its source thread id + kind so the UI can
//     render a separator at thread boundaries.
//
// "Self" and "partner" can each be either the human user (`kind: "user"`)
// or a deployment (`kind: "deployment"`). The only thread kinds that exist
// today are `user_ceo` (user↔CEO) and `agent_dm` (caller↔callee), so the
// valid pair shapes are: user↔deployment, deployment↔user, deployment↔
// deployment. user↔user is never produced.
//
// Sender attribution is derived from `chat_threads` metadata + message
// role rather than stored on the message row: user_ceo "user" = the human,
// "assistant" = the CEO deployment; agent_dm "user" = the caller, "assistant"
// = the callee.

import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { chatMessages, chatThreads } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type InboxPartyKind = "user" | "deployment";
export type InboxThreadKind = "user_ceo" | "agent_dm";

export interface InboxPartnerSummary {
  kind: InboxPartyKind;
  id: string;
  lastMessageAt: Date;
  lastMessageContent: string;
  lastMessageRole: string;
  threadCount: number;
}

export interface InboxMessageRow {
  id: string;
  threadId: string;
  threadKind: InboxThreadKind;
  role: string;
  content: string;
  createdAt: Date;
  senderKind: InboxPartyKind;
  senderId: string;
  createdTaskId: string | null;
}

interface ThreadParticipation {
  threadId: string;
  threadKind: InboxThreadKind;
  partnerKind: InboxPartyKind;
  partnerId: string;
}

// Capped at the maximum reasonable thread set per viewer. Threads grow
// roughly O(active hierarchy depth × tasks delegated), so even a busy
// org will sit well under this limit.
const MESSAGE_FETCH_LIMIT = 500;

export async function listPartnersForAgent(args: {
  companyId: string;
  selfDeploymentId: string;
}): Promise<InboxPartnerSummary[]> {
  const threads = await loadThreadsForAgent(args);
  return aggregatePartners(threads);
}

export async function listPartnersForUser(args: {
  companyId: string;
  userId: string;
}): Promise<InboxPartnerSummary[]> {
  const threads = await loadThreadsForUser(args);
  return aggregatePartners(threads);
}

export async function listMessagesBetween(args: {
  companyId: string;
  selfKind: InboxPartyKind;
  selfId: string;
  partnerKind: InboxPartyKind;
  partnerId: string;
  limit?: number;
}): Promise<InboxMessageRow[]> {
  const threads = await loadThreadsForPair(args);
  if (threads.length === 0) return [];

  const threadIds = threads.map((t) => t.id);
  const rows = await db
    .select()
    .from(chatMessages)
    .where(inArray(chatMessages.threadId, threadIds))
    .orderBy(asc(chatMessages.createdAt))
    .limit(args.limit ?? MESSAGE_FETCH_LIMIT);

  const byId = new Map(threads.map((t) => [t.id, t]));
  return rows.map((m) => {
    const thread = byId.get(m.threadId)!;
    const sender = senderForMessage(thread, m.role);
    return {
      id: m.id,
      threadId: m.threadId,
      threadKind: thread.kind as InboxThreadKind,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      senderKind: sender.kind,
      senderId: sender.id,
      createdTaskId: m.createdTaskId,
    };
  });
}

async function loadThreadsForAgent(args: {
  companyId: string;
  selfDeploymentId: string;
}): Promise<ThreadParticipation[]> {
  // Three sources of participation for a deployment:
  //   (a) user_ceo thread where it is the CEO (deploymentId = self)
  //   (b) agent_dm thread where it is the callee (deploymentId = self)
  //   (c) agent_dm thread where it is the caller
  const rows = await db
    .select()
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.companyId, args.companyId),
        or(
          eq(chatThreads.deploymentId, args.selfDeploymentId),
          eq(chatThreads.callerDeploymentId, args.selfDeploymentId),
        ),
      ),
    );

  const out: ThreadParticipation[] = [];
  for (const row of rows) {
    if (row.kind === "user_ceo") {
      if (!row.userId) continue;
      out.push({
        threadId: row.id,
        threadKind: "user_ceo",
        partnerKind: "user",
        partnerId: row.userId,
      });
      continue;
    }
    if (row.kind === "agent_dm") {
      const partnerId =
        row.deploymentId === args.selfDeploymentId
          ? row.callerDeploymentId
          : row.deploymentId;
      if (!partnerId) continue;
      out.push({
        threadId: row.id,
        threadKind: "agent_dm",
        partnerKind: "deployment",
        partnerId,
      });
    }
  }
  return out;
}

async function loadThreadsForUser(args: {
  companyId: string;
  userId: string;
}): Promise<ThreadParticipation[]> {
  const rows = await db
    .select()
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.companyId, args.companyId),
        eq(chatThreads.kind, "user_ceo"),
        eq(chatThreads.userId, args.userId),
      ),
    );
  return rows.map((row) => ({
    threadId: row.id,
    threadKind: "user_ceo",
    partnerKind: "deployment",
    partnerId: row.deploymentId,
  }));
}

async function loadThreadsForPair(args: {
  companyId: string;
  selfKind: InboxPartyKind;
  selfId: string;
  partnerKind: InboxPartyKind;
  partnerId: string;
}) {
  const rows = await db
    .select()
    .from(chatThreads)
    .where(eq(chatThreads.companyId, args.companyId));

  return rows.filter((t) => {
    if (args.selfKind === "user" && args.partnerKind === "deployment") {
      return (
        t.kind === "user_ceo" &&
        t.userId === args.selfId &&
        t.deploymentId === args.partnerId
      );
    }
    if (args.selfKind === "deployment" && args.partnerKind === "user") {
      return (
        t.kind === "user_ceo" &&
        t.deploymentId === args.selfId &&
        t.userId === args.partnerId
      );
    }
    if (args.selfKind === "deployment" && args.partnerKind === "deployment") {
      if (t.kind !== "agent_dm") return false;
      return (
        (t.deploymentId === args.selfId &&
          t.callerDeploymentId === args.partnerId) ||
        (t.callerDeploymentId === args.selfId &&
          t.deploymentId === args.partnerId)
      );
    }
    return false;
  });
}

async function aggregatePartners(
  threads: ThreadParticipation[],
): Promise<InboxPartnerSummary[]> {
  if (threads.length === 0) return [];
  const threadIds = threads.map((t) => t.threadId);

  const messages = await db
    .select({
      threadId: chatMessages.threadId,
      content: chatMessages.content,
      role: chatMessages.role,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(inArray(chatMessages.threadId, threadIds))
    .orderBy(desc(chatMessages.createdAt));

  const threadToPartnerKey = new Map<string, string>();
  const partners = new Map<
    string,
    { summary: InboxPartnerSummary; threadIds: Set<string> }
  >();
  for (const t of threads) {
    const key = `${t.partnerKind}:${t.partnerId}`;
    threadToPartnerKey.set(t.threadId, key);
    if (!partners.has(key)) {
      partners.set(key, {
        summary: {
          kind: t.partnerKind,
          id: t.partnerId,
          lastMessageAt: new Date(0),
          lastMessageContent: "",
          lastMessageRole: "",
          threadCount: 0,
        },
        threadIds: new Set(),
      });
    }
    partners.get(key)!.threadIds.add(t.threadId);
  }

  // Messages are sorted desc by createdAt — first hit per partner wins.
  for (const msg of messages) {
    const key = threadToPartnerKey.get(msg.threadId);
    if (!key) continue;
    const entry = partners.get(key);
    if (!entry) continue;
    if (entry.summary.lastMessageAt.getTime() === 0) {
      entry.summary.lastMessageAt = msg.createdAt;
      entry.summary.lastMessageContent = msg.content;
      entry.summary.lastMessageRole = msg.role;
    }
  }

  for (const entry of partners.values()) {
    entry.summary.threadCount = entry.threadIds.size;
  }

  return Array.from(partners.values())
    .map((e) => e.summary)
    .filter((s) => s.lastMessageAt.getTime() > 0)
    .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
}

function senderForMessage(
  thread: typeof chatThreads.$inferSelect,
  role: string,
): { kind: InboxPartyKind; id: string } {
  if (thread.kind === "user_ceo") {
    if (role === "user" && thread.userId) {
      return { kind: "user", id: thread.userId };
    }
    return { kind: "deployment", id: thread.deploymentId };
  }
  // agent_dm — the directive row is role=user (caller); replies are
  // role=assistant (callee).
  if (role === "user" && thread.callerDeploymentId) {
    return { kind: "deployment", id: thread.callerDeploymentId };
  }
  return { kind: "deployment", id: thread.deploymentId };
}
