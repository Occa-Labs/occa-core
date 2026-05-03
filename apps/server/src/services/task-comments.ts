// Task comment service — handles `@<agent-name>` parsing, comment row
// inserts, and routes a wake to every mentioned agent so they pick up the
// task in their next dispatch.
//
// `@name` tokens are resolved against agents in the same company. Names
// are matched case-insensitive on the literal `agents.name` column —
// future improvement: also accept a slug or external id.

import { and, eq, inArray } from "drizzle-orm";
import { agents, taskComments, tasks } from "@occa/shared/schema";
import type { TaskCommentDTO } from "@occa/shared/types";
import { db } from "../infra/database/client";
import { enqueueTaskDispatch } from "../infra/queue/task-worker";
import { childLogger } from "../lib/logger";

const log = childLogger("task-comments");

// Greedy `@token` matcher. Tokens may contain letters, digits, underscore,
// hyphen — terminated by whitespace, punctuation, or end of string. The
// resolver only accepts tokens that match an agent name in the same
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
  // Pull every agent in the company; tokens lookup is case-insensitive
  // and tolerant of small list sizes (typically <50 agents per company).
  const agentRows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const byLower = new Map<string, ResolvedMention>();
  for (const a of agentRows) {
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
  // determines which agents (if any) get woken from `@self`-self mentions
  // (we skip self-wakes regardless).
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

  // Sanity-check the task belongs to the same company.
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
  // Don't wake yourself — skip the author from the wake list (mention
  // can still appear in the resolved set for UI display).
  const wakeIds = mentions
    .map((m) => m.id)
    .filter((id) => id !== input.authorAgentId);

  const [row] = await db
    .insert(taskComments)
    .values({
      taskId: input.taskId,
      companyId: input.companyId,
      authorAgentId: input.authorAgentId ?? null,
      authorUserId: input.authorUserId ?? null,
      body: input.body,
      mentions: mentions.map((m) => m.id),
    })
    .returning();

  // Wake mentioned agents — re-enqueue their currently-assigned tasks
  // (if any are dispatchable). For now we simply wake by re-dispatching
  // the comment's task if the mentioned agent is the assignee, OR fall
  // back to flipping their other in-flight task. v1 simplification:
  // re-enqueue this comment's task for each mentioned-but-not-author
  // agent. Refinement: per-agent "inbox" semantic comes with the full
  // L1 heartbeat layer.
  for (const id of wakeIds) {
    void wakeAgentForComment(id, input.taskId).catch((err) => {
      log.error({ err, agentId: id, taskId: input.taskId }, "wake-on-mention failed");
    });
  }

  // Author display name for the agent case — single fast lookup against
  // the in-memory map we already built above is unnecessary; we just
  // pull the row by id.
  let authorAgentName: string | null = null;
  if (input.authorAgentId) {
    const [a] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, input.authorAgentId))
      .limit(1);
    authorAgentName = a?.name ?? null;
  }

  return {
    comment: {
      id: row.id,
      taskId: row.taskId,
      authorAgentId: row.authorAgentId ?? null,
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

// Re-dispatch the agent's currently assigned task for `taskId`. If the
// mentioned agent isn't on this task, find any of their dispatchable
// tasks and bump that one. Nothing happens if the agent has no
// dispatchable task — they'll see the comment next time they wake.
async function wakeAgentForComment(
  mentionedAgentId: string,
  taskId: string,
): Promise<void> {
  const [row] = await db
    .select({
      id: tasks.id,
      assignedAgentId: tasks.assignedAgentId,
      status: tasks.status,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (!row) return;

  // Direct mention on a task they own → re-dispatch that task. Otherwise
  // skip — the agent will see the comment next time they wake on this
  // task or any other. (No background "mentions inbox" exists yet.)
  if (row.assignedAgentId !== mentionedAgentId) return;

  // Reset to dispatchable state, mirroring cascade logic.
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

  // Hydrate agent names for both authors and mentions in one query.
  const allAgentIds = new Set<string>();
  for (const r of rows) {
    if (r.authorAgentId) allAgentIds.add(r.authorAgentId);
    for (const id of r.mentions) allAgentIds.add(id);
  }
  const idList = Array.from(allAgentIds);
  const nameMap = new Map<string, string>();
  if (idList.length > 0) {
    const fetched = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, idList));
    for (const a of fetched) nameMap.set(a.id, a.name);
  }

  return rows.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    authorAgentId: r.authorAgentId ?? null,
    authorUserId: r.authorUserId ?? null,
    authorAgentName: r.authorAgentId
      ? (nameMap.get(r.authorAgentId) ?? null)
      : null,
    body: r.body,
    mentions: r.mentions,
    mentionNames: r.mentions
      .map((id) => nameMap.get(id))
      .filter((n): n is string => n != null),
    createdAt: r.createdAt.toISOString(),
  }));
}
