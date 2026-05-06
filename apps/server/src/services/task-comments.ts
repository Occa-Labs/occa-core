// Task comment service — handles `@<agent-name>` parsing, comment row
// inserts, and routes a wake to every mentioned deployment so they pick
// up the task in their next dispatch.
//
// `@name` tokens are resolved against deployments in the same company.
// Names live on `agent_identities`, surfaced via JOIN. Matching is
// case-insensitive on the literal name; future improvement: also accept
// a slug or external id.

import { and, eq, inArray } from "drizzle-orm";
import {
  agentIdentities,
  deployments,
  taskComments,
  tasks,
} from "@occa/shared/schema";
import type { TaskCommentDTO } from "@occa/shared/types";
import { db } from "../infra/database/client";
import { enqueueTaskDispatch } from "../infra/queue/task-worker";
import { childLogger } from "../lib/logger";

const log = childLogger("task-comments");

// Greedy `@token` matcher. Tokens may contain letters, digits, underscore,
// hyphen — terminated by whitespace, punctuation, or end of string. The
// resolver only accepts tokens that match a deployment name in the same
// company; anything else is left in the body untouched.
const MENTION_TOKEN_RE = /@([A-Za-z0-9_-]+)/g;

export function extractMentionTokens(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION_TOKEN_RE)) {
    const token = match[1];
    const key = token.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(token);
    }
  }
  return out;
}

interface ResolvedMention {
  id: string;
  name: string;
}

async function resolveMentions(
  companyId: string,
  tokens: string[],
): Promise<ResolvedMention[]> {
  if (tokens.length === 0) return [];
  const rows = await db
    .select({ id: deployments.id, name: agentIdentities.name })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(eq(deployments.companyId, companyId));

  const byLower = new Map<string, ResolvedMention>();
  for (const a of rows) {
    byLower.set(a.name.toLowerCase(), { id: a.id, name: a.name });
  }

  const resolved: ResolvedMention[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    const hit = byLower.get(t.toLowerCase());
    if (hit && !seen.has(hit.id)) {
      seen.add(hit.id);
      resolved.push(hit);
    }
  }
  return resolved;
}

export interface CreateCommentInput {
  taskId: string;
  companyId: string;
  body: string;
  // Exactly one of these must be set — author identity drives audit and
  // determines which deployments (if any) get woken from `@self`-self
  // mentions (we skip self-wakes regardless). The `Agent` field name is
  // kept on the public API surface pending the shared/types migration;
  // the value is a deployment UUID.
  authorAgentId?: string | null;
  authorUserId?: string | null;
}

export interface CreateCommentResult {
  comment: TaskCommentDTO;
  wokenAgentIds: string[];
}

export async function createTaskComment(
  input: CreateCommentInput,
): Promise<CreateCommentResult> {
  if (!!input.authorAgentId === !!input.authorUserId) {
    throw new Error(
      "comment_author_invalid: exactly one of authorAgentId or authorUserId required",
    );
  }

  const [taskRow] = await db
    .select({ id: tasks.id, companyId: tasks.companyId })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1);
  if (!taskRow || taskRow.companyId !== input.companyId) {
    throw new Error("comment_task_not_in_company");
  }

  const tokens = extractMentionTokens(input.body);
  const mentions = await resolveMentions(input.companyId, tokens);
  // Don't wake yourself.
  const wakeIds = mentions
    .map((m) => m.id)
    .filter((id) => id !== input.authorAgentId);

  const [row] = await db
    .insert(taskComments)
    .values({
      taskId: input.taskId,
      companyId: input.companyId,
      authorDeploymentId: input.authorAgentId ?? null,
      authorUserId: input.authorUserId ?? null,
      body: input.body,
      mentions: mentions.map((m) => m.id),
    })
    .returning();

  // Wake mentioned deployments — re-enqueue their currently-assigned
  // tasks (if any are dispatchable). v1 simplification: re-enqueue this
  // comment's task for each mentioned-but-not-author deployment.
  // Refinement: per-deployment "inbox" semantic comes with the full L1
  // heartbeat layer.
  for (const id of wakeIds) {
    void wakeAgentForComment(id, input.taskId).catch((err) => {
      log.error(
        { err, deploymentId: id, taskId: input.taskId },
        "wake-on-mention failed",
      );
    });
  }

  let authorAgentName: string | null = null;
  if (input.authorAgentId) {
    const [a] = await db
      .select({ name: agentIdentities.name })
      .from(deployments)
      .innerJoin(
        agentIdentities,
        eq(deployments.agentIdentityId, agentIdentities.id),
      )
      .where(eq(deployments.id, input.authorAgentId))
      .limit(1);
    authorAgentName = a?.name ?? null;
  }

  return {
    comment: {
      id: row.id,
      taskId: row.taskId,
      authorAgentId: row.authorDeploymentId ?? null,
      authorUserId: row.authorUserId ?? null,
      authorAgentName,
      body: row.body,
      mentions: row.mentions,
      mentionNames: mentions.map((m) => m.name),
      createdAt: row.createdAt.toISOString(),
    },
    wokenAgentIds: wakeIds,
  };
}

// Re-dispatch the deployment's currently assigned task for `taskId`. If
// the mentioned deployment isn't on this task, skip — the agent will
// see the comment next time they wake on this task or any other.
async function wakeAgentForComment(
  mentionedDeploymentId: string,
  taskId: string,
): Promise<void> {
  const [row] = await db
    .select({
      id: tasks.id,
      assignedDeploymentId: tasks.assignedDeploymentId,
      status: tasks.status,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (!row) return;
  if (row.assignedDeploymentId !== mentionedDeploymentId) return;

  await db
    .update(tasks)
    .set({
      status: "todo",
      linkedTraceId: null,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, row.id));
  await enqueueTaskDispatch(row.id);
}

// Convenience for read endpoints — converts a row + lookup map to DTO.
export async function listTaskComments(
  taskId: string,
  companyId: string,
): Promise<TaskCommentDTO[]> {
  const rows = await db
    .select()
    .from(taskComments)
    .where(
      and(
        eq(taskComments.taskId, taskId),
        eq(taskComments.companyId, companyId),
      ),
    )
    .orderBy(taskComments.createdAt);

  if (rows.length === 0) return [];

  // Hydrate names for both authors and mentions in one query.
  const allDeploymentIds = new Set<string>();
  for (const r of rows) {
    if (r.authorDeploymentId) allDeploymentIds.add(r.authorDeploymentId);
    for (const id of r.mentions) allDeploymentIds.add(id);
  }
  const idList = Array.from(allDeploymentIds);
  const nameMap = new Map<string, string>();
  if (idList.length > 0) {
    const fetched = await db
      .select({ id: deployments.id, name: agentIdentities.name })
      .from(deployments)
      .innerJoin(
        agentIdentities,
        eq(deployments.agentIdentityId, agentIdentities.id),
      )
      .where(inArray(deployments.id, idList));
    for (const a of fetched) nameMap.set(a.id, a.name);
  }

  return rows.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    authorAgentId: r.authorDeploymentId ?? null,
    authorUserId: r.authorUserId ?? null,
    authorAgentName: r.authorDeploymentId
      ? (nameMap.get(r.authorDeploymentId) ?? null)
      : null,
    body: r.body,
    mentions: r.mentions,
    mentionNames: r.mentions
      .map((id) => nameMap.get(id))
      .filter((n): n is string => n != null),
    createdAt: r.createdAt.toISOString(),
  }));
}
