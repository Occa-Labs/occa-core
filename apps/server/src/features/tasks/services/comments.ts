// Comment lifecycle: parse `@<name>` tokens, resolve to deployments in
// the same company, insert the row, wake mentioned deployments, emit a
// `comment_added` event. Mention resolution is case-insensitive on the
// literal `agent_identities.name`; a future improvement is to also
// accept slugs or external ids.

import { eq } from "drizzle-orm";
import { agentIdentities, deployments } from "@occa/shared/schema";
import type { TaskCommentDTO } from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";
import { enqueueTaskDispatch } from "../../../infra/queue/task-worker";
import {
  insertTaskComment,
  listCompanyDeploymentNames,
  listTaskCommentsByTask,
  deploymentNameMap,
} from "../repositories/task-comments";
import {
  findTaskById,
  findTaskInCompany,
  updateTask,
} from "../repositories/tasks";
import { appendTaskEventBestEffort } from "./events";

const log = childLogger("services:tasks:comments");

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
  const rows = await listCompanyDeploymentNames(companyId);
  const byLower = new Map<string, ResolvedMention>();
  for (const r of rows) byLower.set(r.name.toLowerCase(), r);
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
  // Exactly one of these must be set. The deployment uuid (if author is
  // an agent) is stored as `authorDeploymentId` in DB; the wire type
  // still surfaces it as `authorAgentId` pending the shared/types
  // migration.
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

  const task = await findTaskInCompany(input.taskId, input.companyId);
  if (!task) throw new Error("comment_task_not_in_company");

  const tokens = extractMentionTokens(input.body);
  const mentions = await resolveMentions(input.companyId, tokens);
  const wakeIds = mentions
    .map((m) => m.id)
    .filter((id) => id !== input.authorAgentId);

  const row = await insertTaskComment({
    taskId: input.taskId,
    companyId: input.companyId,
    authorDeploymentId: input.authorAgentId ?? null,
    authorUserId: input.authorUserId ?? null,
    body: input.body,
    mentions: mentions.map((m) => m.id),
  });

  void appendTaskEventBestEffort({
    companyId: input.companyId,
    taskId: input.taskId,
    eventType: "comment_added",
    actorType: input.authorAgentId ? "agent" : "user",
    actorId: input.authorAgentId ?? input.authorUserId ?? null,
    payload: {
      commentId: row.id,
      body: row.body,
      mentions: row.mentions,
    },
  });

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

// Re-dispatch the deployment's currently assigned task. If the mentioned
// deployment isn't on this task, skip — the agent will see the comment
// next time they wake on this task or any other.
//
// Behaviour preserved verbatim from legacy task-comments: unconditional
// flip to `todo` + clear `linkedTraceId`. Re-opens even closed tasks
// when a teammate @-mentions the assigned agent.
async function wakeAgentForComment(
  mentionedDeploymentId: string,
  taskId: string,
): Promise<void> {
  const task = await findTaskById(taskId);
  if (!task) return;
  if (task.assignedDeploymentId !== mentionedDeploymentId) return;
  await updateTask(task.id, { status: "todo", linkedTraceId: null });
  await enqueueTaskDispatch(task.id);
}

export async function listTaskComments(
  taskId: string,
  companyId: string,
): Promise<TaskCommentDTO[]> {
  const rows = await listTaskCommentsByTask(taskId, companyId);
  if (rows.length === 0) return [];

  const allDeploymentIds = new Set<string>();
  for (const r of rows) {
    if (r.authorDeploymentId) allDeploymentIds.add(r.authorDeploymentId);
    for (const id of r.mentions) allDeploymentIds.add(id);
  }
  const nameMap = await deploymentNameMap(Array.from(allDeploymentIds));

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
