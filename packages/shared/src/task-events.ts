// Shared task-events helper. Single source of truth for the event-type
// enum, payload shapes, and append semantics. Both `apps/server` (HTTP /
// dispatcher / cascade) and `apps/worker` (trace dispatcher / task-sync)
// dual-write through this so the timeline log stays consistent across
// runtimes — adding a new event type here propagates everywhere without
// drift.
//
// The runtime helpers take the drizzle client as a parameter so each
// runtime can pass its own pool. Schema reference is the canonical
// `taskEvents` table from this package.

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { taskEvents } from "./schema";

const MAX_APPEND_RETRY = 5;
const PG_UNIQUE_VIOLATION = "23505";

export type TaskEventType =
  | "task_created"
  | "task_assigned"
  | "task_status_changed"
  | "agent_trace_started"
  | "agent_trace_finished"
  | "agent_action_emitted"
  | "comment_added"
  | "task_blocked"
  | "task_unblocked"
  | "task_archived"
  | "task_unarchived";

export type TaskEventActorType = "user" | "agent" | "system";

export interface TaskCreatedPayload {
  title: string;
  taskType: string;
  parentTaskId: string | null;
  via?: "EmitFollowUp" | "delegate" | "ui";
}

export interface TaskAssignedPayload {
  deploymentId: string | null;
  previousDeploymentId?: string | null;
}

export interface TaskStatusChangedPayload {
  from: string;
  to: string;
  reason:
    | "agent_action"
    | "user_edit"
    | "dispatch_started"
    | "trace_failed"
    | "trace_finished"
    | "trace_succeeded"
    | "blockers_resolved"
    | "child_completed"
    | "request_info";
  childTaskId?: string;
  lastBlockerTaskId?: string;
}

export interface AgentTraceStartedPayload {
  traceId: string;
  deploymentId: string;
}

export interface AgentTraceFinishedPayload {
  traceId: string;
  outcome: "success" | "error" | "review" | "blocked";
  error?: string;
}

export interface AgentActionEmittedPayload {
  // Includes block-marker tokens (DELEGATE/BLOCK/REVIEW) and
  // HTTP-channel action types (EmitFollowUp/RequestInfo). Stable wire
  // strings — additions here are non-breaking.
  actionType: string;
  channel: "block_marker" | "http";
  outcome?: string;
  actionPayload?: unknown;
  childTaskId?: string;
  commentId?: string;
  blockerIds?: string[];
  reason?: string;
  title?: string;
}

export interface CommentAddedPayload {
  commentId: string;
  body: string;
  mentions: string[];
}

export interface TaskBlockedPayload {
  blockedByTaskIds: string[];
  reason?: string;
}

export interface TaskUnblockedPayload {
  by: "cascade" | "manual";
  lastBlockerTaskId?: string;
}

export interface AppendTaskEventInput {
  companyId: string;
  taskId: string;
  eventType: TaskEventType;
  actorType: TaskEventActorType;
  actorId?: string | null;
  payload?: Record<string, unknown>;
  traceId?: string | null;
}

export type TaskEventRow = typeof taskEvents.$inferSelect;

// Drizzle wraps the underlying pg error in DrizzleQueryError, so the
// SQLSTATE may live on either err.code (older versions) or
// err.cause.code (current). Accept both for forward compatibility.
function isUniqueViolation(err: unknown): boolean {
  const direct = (err as { code?: string } | null)?.code;
  const wrapped = (err as { cause?: { code?: string } } | null)?.cause?.code;
  return direct === PG_UNIQUE_VIOLATION || wrapped === PG_UNIQUE_VIOLATION;
}

// Per-task `sequence` is computed inside the INSERT via MAX+1 subquery.
// Concurrent appends collide on the (task_id, sequence) unique index;
// retry on collision. Per-task contention is normally low so the retry
// path rarely fires.
export async function appendTaskEvent(
  db: NodePgDatabase<Record<string, unknown>>,
  input: AppendTaskEventInput,
): Promise<TaskEventRow> {
  const payload = input.payload ?? {};
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_APPEND_RETRY; attempt++) {
    try {
      const [row] = await db
        .insert(taskEvents)
        .values({
          companyId: input.companyId,
          taskId: input.taskId,
          sequence: sql<number>`COALESCE((SELECT MAX(${taskEvents.sequence}) FROM ${taskEvents} WHERE ${taskEvents.taskId} = ${input.taskId}::uuid), 0) + 1`,
          eventType: input.eventType,
          actorType: input.actorType,
          actorId: input.actorId ?? null,
          payload,
          traceId: input.traceId ?? null,
        })
        .returning();
      return row;
    } catch (err) {
      lastErr = err;
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }
  throw lastErr ?? new Error("task_event_append_max_retry_exceeded");
}

// Best-effort wrapper. Used at dual-write call sites where losing an
// audit row is observability-only and must not break the primary flow.
// `onError` defaults to console.error so the worker (no logger) gets
// visibility; the server can pass its pino childLogger.
export async function appendTaskEventBestEffort(
  db: NodePgDatabase<Record<string, unknown>>,
  input: AppendTaskEventInput,
  onError: (err: unknown, input: AppendTaskEventInput) => void = (
    err,
    inp,
  ) => {
    console.error(
      "[task-events] append failed",
      inp.taskId,
      inp.eventType,
      err instanceof Error ? err.message : err,
    );
  },
): Promise<void> {
  try {
    await appendTaskEvent(db, input);
  } catch (err) {
    onError(err, input);
  }
}
