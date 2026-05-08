// Side-effect handlers for the typed-action HTTP back-channel
// (POST /api/agents/me/actions/emit). Each handler is idempotent through
// the agent_action_idempotency table — a retry by the agent (network
// blip, dispatcher restart) returns the same resource id without
// re-running the side-effect.
//
// Caps come from LIMITS (TASK_CHAIN_MAX_DEPTH, TASK_EMIT_MAX_CHILDREN);
// see task-system-design.md §Hard caps for the empirical rationale.
//
// Cross-feature note: this file lives in features/agents/ but creates
// tasks (a features/tasks concept). It uses the infra/database/task-
// creation primitive so the no-cross-feature-import rule stays clean.
// Mention parsing for RequestInfo also runs through that primitive's
// peer service (createTaskComment lives in features/tasks/services/),
// which is the one explicit cross-feature import we accept here for
// expedience — alternative would be another infra-level wrapper.
// Documented as a known violation; revisit when comments grow more
// behaviour and the primitive is worth extracting.

import { and, eq, sql } from "drizzle-orm";
import { agentActionIdempotency, tasks } from "@occa/shared/schema";
import type { AgentAuthContext } from "../../../middleware/agent-auth";
import { db } from "../../../infra/database/client";
import { createTaskRecord } from "../../../infra/database/task-creation";
import { LIMITS } from "../../../lib/limits";
import { childLogger } from "../../../lib/logger";
import { appendTaskEventBestEffort } from "../../tasks/services/events";
import { createTaskComment } from "../../tasks/services/comments";
import type {
  EmitFollowUpRequest,
  RequestInfoRequest,
} from "../domain/agent-actions-schemas";

const log = childLogger("services:agent-actions");

export type AgentActionFailureReason =
  | "task_not_in_company"
  | "task_depth_exceeded"
  | "task_children_exceeded";

export interface AgentActionResult {
  alreadyExisted: boolean;
}

export interface EmitFollowUpResult extends AgentActionResult {
  taskId: string;
}

export interface RequestInfoResult extends AgentActionResult {
  commentId: string;
}

export class AgentActionError extends Error {
  reason: AgentActionFailureReason;
  constructor(reason: AgentActionFailureReason) {
    super(reason);
    this.reason = reason;
  }
}

async function lookupIdempotencyHit(
  deploymentId: string,
  actionType: string,
  idempotencyKey: string,
): Promise<{ resourceType: string; resourceId: string } | null> {
  const [row] = await db
    .select({
      resourceType: agentActionIdempotency.resourceType,
      resourceId: agentActionIdempotency.resourceId,
    })
    .from(agentActionIdempotency)
    .where(
      and(
        eq(agentActionIdempotency.deploymentId, deploymentId),
        eq(agentActionIdempotency.actionType, actionType),
        eq(agentActionIdempotency.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function recordIdempotency(
  deploymentId: string,
  actionType: string,
  idempotencyKey: string,
  resourceType: string,
  resourceId: string,
): Promise<void> {
  await db
    .insert(agentActionIdempotency)
    .values({
      deploymentId,
      actionType,
      idempotencyKey,
      resourceType,
      resourceId,
    })
    .onConflictDoNothing({
      target: [
        agentActionIdempotency.deploymentId,
        agentActionIdempotency.actionType,
        agentActionIdempotency.idempotencyKey,
      ],
    });
}

async function computeTaskDepth(taskId: string): Promise<number> {
  const result = await db.execute<{ depth: number }>(sql`
    WITH RECURSIVE chain AS (
      SELECT id, parent_task_id, 0 AS depth
      FROM tasks
      WHERE id = ${taskId}::uuid
      UNION ALL
      SELECT t.id, t.parent_task_id, c.depth + 1
      FROM tasks t
      JOIN chain c ON t.id = c.parent_task_id
    )
    SELECT MAX(depth)::int AS depth FROM chain
  `);
  return result.rows[0]?.depth ?? 0;
}

async function countAgentEmittedChildren(
  parentTaskId: string,
  deploymentId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(
      and(
        eq(tasks.parentTaskId, parentTaskId),
        eq(tasks.createdByDeploymentId, deploymentId),
      ),
    );
  return row?.count ?? 0;
}

export async function emitFollowUp(
  agent: AgentAuthContext,
  req: EmitFollowUpRequest,
): Promise<EmitFollowUpResult> {
  const hit = await lookupIdempotencyHit(
    agent.agentId,
    "EmitFollowUp",
    req.idempotencyKey,
  );
  if (hit) {
    return { taskId: hit.resourceId, alreadyExisted: true };
  }

  const [parent] = await db
    .select({ id: tasks.id, companyId: tasks.companyId })
    .from(tasks)
    .where(eq(tasks.id, req.parentTaskId))
    .limit(1);
  if (!parent || parent.companyId !== agent.companyId) {
    throw new AgentActionError("task_not_in_company");
  }

  const parentDepth = await computeTaskDepth(req.parentTaskId);
  if (parentDepth + 1 > LIMITS.TASK_CHAIN_MAX_DEPTH) {
    throw new AgentActionError("task_depth_exceeded");
  }
  const existingChildren = await countAgentEmittedChildren(
    req.parentTaskId,
    agent.agentId,
  );
  if (existingChildren >= LIMITS.TASK_EMIT_MAX_CHILDREN) {
    throw new AgentActionError("task_children_exceeded");
  }

  const blocks = req.payload.acceptanceCriteria
    ? [{ type: "paragraph" as const, text: req.payload.acceptanceCriteria }]
    : [];

  const newTask = await createTaskRecord({
    companyId: agent.companyId,
    title: req.payload.title,
    blocks,
    status: "todo",
    priority: req.payload.priority ?? "medium",
    taskType: req.payload.taskType ?? "other",
    effortLevel: req.payload.effortLevel ?? "m",
    tags: [],
    dueDate: null,
    assignedDeploymentId: null,
    parentTaskId: req.parentTaskId,
    createdByUserId: null,
    createdByDeploymentId: agent.agentId,
    acceptanceCriteria: req.payload.acceptanceCriteria ?? null,
  });

  await recordIdempotency(
    agent.agentId,
    "EmitFollowUp",
    req.idempotencyKey,
    "task",
    newTask.id,
  );

  void appendTaskEventBestEffort({
    companyId: agent.companyId,
    taskId: req.parentTaskId,
    eventType: "agent_action_emitted",
    actorType: "agent",
    actorId: agent.agentId,
    payload: {
      actionType: "EmitFollowUp",
      channel: "http",
      childTaskId: newTask.id,
      title: req.payload.title,
      reason: req.payload.reason,
    },
  });
  void appendTaskEventBestEffort({
    companyId: agent.companyId,
    taskId: newTask.id,
    eventType: "task_created",
    actorType: "agent",
    actorId: agent.agentId,
    payload: {
      title: req.payload.title,
      taskType: req.payload.taskType,
      parentTaskId: req.parentTaskId,
      via: "EmitFollowUp",
    },
  });

  log.info(
    {
      agentId: agent.agentId,
      parentTaskId: req.parentTaskId,
      newTaskId: newTask.id,
    },
    "EmitFollowUp spawned child task",
  );

  return { taskId: newTask.id, alreadyExisted: false };
}

export async function requestInfo(
  agent: AgentAuthContext,
  req: RequestInfoRequest,
): Promise<RequestInfoResult> {
  const hit = await lookupIdempotencyHit(
    agent.agentId,
    "RequestInfo",
    req.idempotencyKey,
  );
  if (hit) {
    return { commentId: hit.resourceId, alreadyExisted: true };
  }

  const [task] = await db
    .select({ id: tasks.id, companyId: tasks.companyId })
    .from(tasks)
    .where(eq(tasks.id, req.taskId))
    .limit(1);
  if (!task || task.companyId !== agent.companyId) {
    throw new AgentActionError("task_not_in_company");
  }

  const result = await createTaskComment({
    taskId: req.taskId,
    companyId: agent.companyId,
    body: req.payload.questionMarkdown,
    authorAgentId: agent.agentId,
    authorUserId: null,
  });

  await recordIdempotency(
    agent.agentId,
    "RequestInfo",
    req.idempotencyKey,
    "comment",
    result.comment.id,
  );

  void appendTaskEventBestEffort({
    companyId: agent.companyId,
    taskId: req.taskId,
    eventType: "agent_action_emitted",
    actorType: "agent",
    actorId: agent.agentId,
    payload: {
      actionType: "RequestInfo",
      channel: "http",
      commentId: result.comment.id,
    },
  });

  log.info(
    {
      agentId: agent.agentId,
      taskId: req.taskId,
      commentId: result.comment.id,
    },
    "RequestInfo posted comment",
  );

  return { commentId: result.comment.id, alreadyExisted: false };
}
