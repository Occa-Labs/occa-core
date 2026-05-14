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

// Returns the id of the user_ceo thread for this (company, ceoDeployment)
// pair, creating it lazily on first call. user_id is populated from
// companies.owner_user_id so cascade synthesis knows who the recipient is.
export async function resolveUserCeoThreadId(args: {
  companyId: string;
  ceoDeploymentId: string;
}): Promise<string> {
  const existing = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.companyId, args.companyId),
        eq(chatThreads.deploymentId, args.ceoDeploymentId),
        eq(chatThreads.kind, "user_ceo"),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0].id;

  const [company] = await db
    .select({ ownerUserId: companies.ownerUserId })
    .from(companies)
    .where(eq(companies.id, args.companyId))
    .limit(1);
  if (!company) {
    throw new Error(
      `resolveUserCeoThreadId: company ${args.companyId} not found`,
    );
  }

  const [inserted] = await db
    .insert(chatThreads)
    .values({
      companyId: args.companyId,
      kind: "user_ceo",
      userId: company.ownerUserId,
      deploymentId: args.ceoDeploymentId,
    })
    .onConflictDoNothing({
      target: [chatThreads.companyId, chatThreads.deploymentId],
      where: sql`kind = 'user_ceo'`,
    })
    .returning({ id: chatThreads.id });
  if (inserted) return inserted.id;

  // Race lost — fetch the winning insert.
  const [winner] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.companyId, args.companyId),
        eq(chatThreads.deploymentId, args.ceoDeploymentId),
        eq(chatThreads.kind, "user_ceo"),
      ),
    )
    .limit(1);
  if (!winner) {
    throw new Error(
      `resolveUserCeoThreadId: insert returned nothing and lookup found no row`,
    );
  }
  return winner.id;
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
  // caller (chat-handler) can return its HTTP response promptly.
  enqueueAgentDmDispatch(thread.id).catch((err) => {
    log.error(
      { err, threadId: thread.id },
      "enqueueAgentDmDispatch failed after openAgentDmThread",
    );
  });
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
