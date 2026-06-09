// Drizzle access for chat_threads — the explicit thread entity introduced
// in Phase C. Two kinds:
//   • user_ceo — user chats with the CEO deployment.
//   • agent_dm — caller deployment opens a directive thread to a callee
//     deployment (Head) without creating a task wrapper.
// Used by chat-handler, task-worker, and delegation/synthesis to resolve
// or open the right thread before writing a chat message.

import { and, eq, sql } from "drizzle-orm";
import { chatThreads, chatMessages, companies } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { enqueueAgentDmDispatch } from "../../../infra/queue/agent-dm-worker";
import { childLogger } from "../../../lib/logger";

const log = childLogger("repositories:chat-threads");

export type ChatThreadRow = typeof chatThreads.$inferSelect;

// Returns the id + resetGeneration of the user_ceo thread for this
// (company, ceoDeployment) pair, creating it lazily on first call.
// user_id is populated from companies.owner_user_id so cascade
// synthesis knows who the recipient is. Callers use resetGeneration
// when deriving the adapter sessionKey via `threadSessionKey()` so a
// `clearThread` reset rotates onto a fresh per-session bucket.
export interface UserCeoThreadHandle {
  id: string;
  resetGeneration: number;
}

export async function resolveUserCeoThreadId(args: {
  companyId: string;
  ceoDeploymentId: string;
}): Promise<UserCeoThreadHandle> {
  return resolveUserThread({
    companyId: args.companyId,
    deploymentId: args.ceoDeploymentId,
    kind: "user_ceo",
  });
}

// Per-agent direct chat thread. Same shape as user_ceo (a 1:1 user↔agent
// conversation owned by the company owner) but tagged `user_agent` so it
// doesn't collide with the single CEO thread. The partial unique index
// `uq_chat_threads_user_agent` guarantees one thread per (company,
// deployment).
export async function resolveUserAgentThreadId(args: {
  companyId: string;
  deploymentId: string;
}): Promise<UserCeoThreadHandle> {
  return resolveUserThread({
    companyId: args.companyId,
    deploymentId: args.deploymentId,
    kind: "user_agent",
  });
}

// Shared resolver for the two 1:1 user↔agent thread kinds (user_ceo,
// user_agent). Both lazily create on first call, populate userId from the
// company owner, and rely on a per-kind partial unique index on
// (companyId, deploymentId) to serialize concurrent creates.
type UserThreadKind = "user_ceo" | "user_agent";

async function resolveUserThread(args: {
  companyId: string;
  deploymentId: string;
  kind: UserThreadKind;
}): Promise<UserCeoThreadHandle> {
  const existing = await db
    .select({
      id: chatThreads.id,
      resetGeneration: chatThreads.resetGeneration,
    })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.companyId, args.companyId),
        eq(chatThreads.deploymentId, args.deploymentId),
        eq(chatThreads.kind, args.kind),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];

  const [company] = await db
    .select({ ownerUserId: companies.ownerUserId })
    .from(companies)
    .where(eq(companies.id, args.companyId))
    .limit(1);
  if (!company) {
    throw new Error(`resolveUserThread: company ${args.companyId} not found`);
  }

  const [inserted] = await db
    .insert(chatThreads)
    .values({
      companyId: args.companyId,
      kind: args.kind,
      userId: company.ownerUserId,
      deploymentId: args.deploymentId,
    })
    .onConflictDoNothing({
      target: [chatThreads.companyId, chatThreads.deploymentId],
      where: sql`kind = ${args.kind}`,
    })
    .returning({
      id: chatThreads.id,
      resetGeneration: chatThreads.resetGeneration,
    });
  if (inserted) return inserted;

  // Race lost — fetch the winning insert.
  const [winner] = await db
    .select({
      id: chatThreads.id,
      resetGeneration: chatThreads.resetGeneration,
    })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.companyId, args.companyId),
        eq(chatThreads.deploymentId, args.deploymentId),
        eq(chatThreads.kind, args.kind),
      ),
    )
    .limit(1);
  if (!winner) {
    throw new Error(
      `resolveUserThread: insert returned nothing and lookup found no row`,
    );
  }
  return winner;
}

// Read the thread's current reset_generation WITHOUT creating it (unlike
// resolveUserThread). Returns 0 when no thread exists yet — the active chat
// of a never-used thread is just the (empty) generation 0.
export async function getThreadResetGeneration(args: {
  companyId: string;
  deploymentId: string;
  kind: UserThreadKind;
}): Promise<number> {
  const [row] = await db
    .select({ resetGeneration: chatThreads.resetGeneration })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.companyId, args.companyId),
        eq(chatThreads.deploymentId, args.deploymentId),
        eq(chatThreads.kind, args.kind),
      ),
    )
    .limit(1);
  return row?.resetGeneration ?? 0;
}

// Increment the thread's reset_generation, forcing the next call to
// `threadSessionKey()` to produce a NEW per-session bucket. Returns the
// new generation. Idempotent in the sense that calling it twice in a
// row simply yields a higher number — no extra cleanup needed.
export async function bumpThreadResetGeneration(
  threadId: string,
): Promise<number> {
  const [row] = await db
    .update(chatThreads)
    .set({ resetGeneration: sql`${chatThreads.resetGeneration} + 1` })
    .where(eq(chatThreads.id, threadId))
    .returning({ resetGeneration: chatThreads.resetGeneration });
  if (!row) {
    throw new Error(
      `bumpThreadResetGeneration: thread ${threadId} not found`,
    );
  }
  return row.resetGeneration;
}

// Opens a new agent_dm thread between two deployments and posts the
// initial directive message. Used when DELEGATE targets a non-leaf
// (Head) — instead of creating a task wrapper for the Head, we open a
// directive conversation the Head's worker will pick up.
//
// The directive content is the brief the caller would otherwise have
// stuffed into a task description. `parentThreadId` links this thread
// into the bubble-up chain so cascade can walk back to the originating
// user_ceo thread when work eventually settles.
export interface OpenAgentDmThreadArgs {
  companyId: string;
  callerDeploymentId: string;
  calleeDeploymentId: string;
  parentThreadId: string;
  directive: {
    title: string;
    body: string;
    acceptanceCriteria?: string | null;
    priority?: string | null;
    tags?: string[] | null;
  };
  // When false, the callee is NOT enqueued for a DM-mode turn. Used for
  // leaf (specialist) delegations where the callee runs via the spawned
  // task and only posts a synthesised status reply back to this thread
  // on task completion. Default true preserves Head-target behavior.
  autoDispatch?: boolean;
}

export async function openAgentDmThread(
  args: OpenAgentDmThreadArgs,
): Promise<{ threadId: string; messageId: string }> {
  const [thread] = await db
    .insert(chatThreads)
    .values({
      companyId: args.companyId,
      kind: "agent_dm",
      userId: null,
      deploymentId: args.calleeDeploymentId,
      callerDeploymentId: args.callerDeploymentId,
      parentThreadId: args.parentThreadId,
    })
    .returning({ id: chatThreads.id });
  if (!thread) {
    throw new Error("openAgentDmThread: insert returned no row");
  }

  const directiveBody = formatDirectiveBody(args.directive);
  const [msg] = await db
    .insert(chatMessages)
    .values({
      threadId: thread.id,
      companyId: args.companyId,
      // For agent_dm messages the "owning" deployment of the row is the
      // callee (the recipient who will reply). Mirrors how user_ceo rows
      // are owned by the CEO deployment regardless of role.
      deploymentId: args.calleeDeploymentId,
      // Caller-posted directive is the equivalent of a user prompt in
      // user_ceo threads — the next worker turn is the callee's reply.
      role: "user",
      content: directiveBody,
      createdTaskId: null,
      traceId: null,
    })
    .returning({ id: chatMessages.id });
  if (!msg) {
    throw new Error("openAgentDmThread: directive message insert returned no row");
  }
  // Fire-and-forget: the worker will pick up the directive within the
  // queue's polling interval (~2s). We don't await the dispatch so the
  // caller (chat-handler) can return its HTTP response promptly. Leaf
  // delegations pass autoDispatch=false because the specialist runs via
  // task, not DM — the dm thread is observability-only until cascade
  // synthesizes the task result back into it.
  if (args.autoDispatch !== false) {
    enqueueAgentDmDispatch(thread.id).catch((err) => {
      log.error(
        { err, threadId: thread.id },
        "enqueueAgentDmDispatch failed after openAgentDmThread",
      );
    });
  }
  return { threadId: thread.id, messageId: msg.id };
}

function formatDirectiveBody(directive: OpenAgentDmThreadArgs["directive"]): string {
  const lines = [`# ${directive.title}`, "", directive.body.trim()];
  if (directive.acceptanceCriteria && directive.acceptanceCriteria.trim()) {
    lines.push("", "## Acceptance criteria", directive.acceptanceCriteria.trim());
  }
  if (directive.tags && directive.tags.length > 0) {
    lines.push("", `Tags: ${directive.tags.join(", ")}`);
  }
  if (directive.priority) {
    lines.push("", `Priority: ${directive.priority}`);
  }
  return lines.join("\n");
}
