// Side-effect handlers for the typed-action HTTP back-channel
// (POST /api/agents/me/actions/emit). Each handler is idempotent through
// the agent_action_idempotency table — a retry by the agent (network
// blip, dispatcher restart) returns the same resource id without
// re-running the side-effect.
//
// Caps come from LIMITS (TASK_CHAIN_MAX_DEPTH, TASK_EMIT_MAX_CHILDREN);
// see lib/limits.ts for the rationale on each value.
//
// Cross-feature note: this file lives in features/agents/ but creates
// tasks (a features/tasks concept). It uses the infra/database/task-
// creation primitive plus the shared @occa/shared/task-events helper
// for audit rows so no features/tasks/ code is imported for that path.
// `createTaskComment` is still imported from features/tasks/services/
// for RequestInfo's mention-parsed comment insert — the only remaining
// cross-feature import in this file. Threading it via composition-root
// DI is medium-risk plumbing (router/index changes); revisit when
// comments grow more behaviour and a properly extracted primitive is
// worth the churn.

import { and, eq, sql } from "drizzle-orm";
import { agentActionIdempotency, tasks } from "@occa/shared/schema";
import { appendTaskEventBestEffort } from "@occa/shared/task-events";
import type { AgentAuthContext } from "../../../middleware/agent-auth";
import { db } from "../../../infra/database/client";
import {
  createTaskRecord,
  type TaskTx,
} from "../../../infra/database/task-creation";
import { LIMITS } from "../../../lib/limits";
import { childLogger } from "../../../lib/logger";
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

// Returns true if this caller claimed the slot, false if a concurrent
// same-key request beat us to it. Used inside a transaction so the
// caller can roll the side-effect back when the slot is already taken.
async function tryClaimIdempotency(
  tx: TaskTx,
  deploymentId: string,
  actionType: string,
  idempotencyKey: string,
  resourceType: string,
  resourceId: string,
): Promise<boolean> {
  const inserted = await tx
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
    })
    .returning({ id: agentActionIdempotency.id });
  return inserted.length > 0;
}

class IdempotencyRaceLost extends Error {
  constructor() {
    super("idempotency_race_lost");
    this.name = "IdempotencyRaceLost";
  }
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

  // Atomic: child task insert + idempotency slot claim. If a concurrent
  // same-key request claimed the slot first, throw to roll the task
  // insert back — prevents orphan tasks that wouldn't be returned on
  // retry. The thrown sentinel is caught below.
  let newTask;
  try {
    newTask = await db.transaction(async (tx) => {
      const created = await createTaskRecord(
        {
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
        },
        tx,
      );
      const claimed = await tryClaimIdempotency(
        tx,
        agent.agentId,
        "EmitFollowUp",
        req.idempotencyKey,
        "task",
        created.id,
      );
      if (!claimed) throw new IdempotencyRaceLost();
      return created;
    });
  } catch (err) {
    if (err instanceof IdempotencyRaceLost) {
      const winner = await lookupIdempotencyHit(
        agent.agentId,
        "EmitFollowUp",
        req.idempotencyKey,
      );
      if (winner) {
        return { taskId: winner.resourceId, alreadyExisted: true };
      }
      // Lost the race but winner row vanished — extremely unlikely
      // (would require a concurrent delete), but bubble up rather than
      // pretend success.
      throw err;
    }
    throw err;
  }

  void appendTaskEventBestEffort(db, {
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
  void appendTaskEventBestEffort(db, {
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

  // Fast-fail: bail out before creating a comment if the task is in a
  // different company. Re-checked under FOR UPDATE below, but this
  // saves an orphan comment in the obvious mis-routed case.
  const [precheck] = await db
    .select({ companyId: tasks.companyId })
    .from(tasks)
    .where(eq(tasks.id, req.taskId))
    .limit(1);
  if (!precheck || precheck.companyId !== agent.companyId) {
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

  // RequestInfo pauses the task: emit the comment, flip to `review`
  // from any active state, notify the user. A closed task stays closed
  // (no resurrect). Skip the status change + event emission when the
  // task is already in `review` or `done` to keep the timeline tidy.
  //
  // FOR UPDATE row-lock serialises us against the dispatcher: it stops
  // a concurrent status flip from clobbering our pause (or vice versa).
  // The status read happens inside the lock so our decision uses fresh
  // state, not whatever we read seconds ago in the precheck.
  let pausedTo: string | null = null;
  let priorStatus: string | null = null;
  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, req.taskId))
      .for("update")
      .limit(1);
    if (!locked) return;
    priorStatus = locked.status;
    if (locked.status === "todo" || locked.status === "in_progress") {
      await tx
        .update(tasks)
        .set({
          status: "review",
          linkedTraceId: null,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, req.taskId));
      pausedTo = "review";
    }
  });
  if (pausedTo) {
    void appendTaskEventBestEffort(db, {
      companyId: agent.companyId,
      taskId: req.taskId,
      eventType: "task_status_changed",
      actorType: "agent",
      actorId: agent.agentId,
      payload: {
        from: priorStatus,
        to: "review",
        reason: "request_info",
        commentId: result.comment.id,
      },
    });
  }

  void appendTaskEventBestEffort(db, {
    companyId: agent.companyId,
    taskId: req.taskId,
    eventType: "agent_action_emitted",
    actorType: "agent",
    actorId: agent.agentId,
    payload: {
      actionType: "RequestInfo",
      channel: "http",
      commentId: result.comment.id,
      pausedTo,
    },
  });

  log.info(
    {
      agentId: agent.agentId,
      taskId: req.taskId,
      commentId: result.comment.id,
      pausedTo,
    },
    "RequestInfo posted comment + paused task",
  );

  return { commentId: result.comment.id, alreadyExisted: false };
}
