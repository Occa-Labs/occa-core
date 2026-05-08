// Drizzle access for `task_events`. Append semantics live in
// `@occa/shared/task-events` so server and worker stay in lockstep; this
// repository just binds the server's drizzle client and adds the read
// helpers (only the server queries the timeline).

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { taskEvents } from "@occa/shared/schema";
import {
  appendTaskEvent as appendTaskEventShared,
  type AppendTaskEventInput,
  type TaskEventRow,
  type TaskEventType,
} from "@occa/shared/task-events";
import { db } from "../../../infra/database/client";

export type { TaskEventRow };

export async function appendTaskEvent(
  input: AppendTaskEventInput,
): Promise<TaskEventRow> {
  return appendTaskEventShared(db, input);
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
