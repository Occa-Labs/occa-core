// Drizzle access for `task_events`. Append-only — no UPDATE / DELETE
// here or anywhere else in the application code path.
//
// Per-task `sequence` is computed inside the INSERT via
// `MAX(sequence) + 1` subquery. Concurrent appends collide on the
// (task_id, sequence) unique index; we retry up to MAX_RETRY times.
// Contention per task is normally low (one writer at a time), so the
// retry path rarely fires.

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { taskEvents } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { PG_ERROR_CODES } from "../../../lib/pg-errors";
import type {
  AppendTaskEventInput,
  TaskEventType,
} from "../domain/task-events";

const MAX_APPEND_RETRY = 5;

export type TaskEventRow = typeof taskEvents.$inferSelect;

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === PG_ERROR_CODES.UNIQUE_VIOLATION
  );
}

export async function appendTaskEvent(
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

export interface ListTaskEventsOptions {
  afterSequence?: number;
  eventTypes?: TaskEventType[];
  limit?: number;
}

export async function listTaskEvents(
  taskId: string,
  opts: ListTaskEventsOptions = {},
): Promise<TaskEventRow[]> {
  const conditions = [eq(taskEvents.taskId, taskId)];
  if (opts.afterSequence != null) {
    conditions.push(sql`${taskEvents.sequence} > ${opts.afterSequence}`);
  }
  if (opts.eventTypes && opts.eventTypes.length > 0) {
    conditions.push(inArray(taskEvents.eventType, opts.eventTypes));
  }
  const query = db
    .select()
    .from(taskEvents)
    .where(and(...conditions))
    .orderBy(asc(taskEvents.sequence));
  return opts.limit != null ? query.limit(opts.limit) : query;
}

export async function getLatestTaskEvent(
  taskId: string,
): Promise<TaskEventRow | null> {
  const [row] = await db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(desc(taskEvents.sequence))
    .limit(1);
  return row ?? null;
}
