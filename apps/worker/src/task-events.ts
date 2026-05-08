// Worker-side mirror of apps/server/src/features/tasks/services/events.ts
// (and its repository peer). The worker trace dispatcher and task-sync
// need to append events without going through the server HTTP layer.
// Same insert semantics; uses the worker's drizzle client.

import { sql } from "drizzle-orm";
import { taskEvents } from "@occa/shared/schema";
import { db } from "./db";

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
  | "task_unblocked";

export type TaskEventActorType = "user" | "agent" | "system";

export interface AppendTaskEventInput {
  companyId: string;
  taskId: string;
  eventType: TaskEventType;
  actorType: TaskEventActorType;
  actorId?: string | null;
  payload?: Record<string, unknown>;
  traceId?: string | null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

async function appendTaskEvent(input: AppendTaskEventInput): Promise<void> {
  const payload = input.payload ?? {};
  for (let attempt = 0; attempt < MAX_APPEND_RETRY; attempt++) {
    try {
      await db.insert(taskEvents).values({
        companyId: input.companyId,
        taskId: input.taskId,
        sequence: sql<number>`COALESCE((SELECT MAX(${taskEvents.sequence}) FROM ${taskEvents} WHERE ${taskEvents.taskId} = ${input.taskId}::uuid), 0) + 1`,
        eventType: input.eventType,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        payload,
        traceId: input.traceId ?? null,
      });
      return;
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_APPEND_RETRY - 1) {
        continue;
      }
      throw err;
    }
  }
  throw new Error("task_event_append_max_retry_exceeded");
}

// Best-effort wrapper — used at dual-write call sites where losing an
// event row is observability-only and must not break the primary flow.
export async function appendTaskEventBestEffort(
  input: AppendTaskEventInput,
): Promise<void> {
  try {
    await appendTaskEvent(input);
  } catch (err) {
    console.error(
      "[worker:task-events] append failed",
      input.taskId,
      input.eventType,
      err instanceof Error ? err.message : err,
    );
  }
}
