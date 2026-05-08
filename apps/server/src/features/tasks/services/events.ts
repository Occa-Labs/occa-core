// Service-layer wrapper around the task-events repository. Every dual-
// write call site uses `appendTaskEventBestEffort` so a failure to
// persist the audit row never breaks the parent operation. The
// `appendTaskEvent` strict variant is exposed for callers that want the
// row id (e.g. tests, future workflow engine).

import { childLogger } from "../../../lib/logger";
import {
  appendTaskEvent as appendTaskEventRepo,
  listTaskEvents as listTaskEventsRepo,
  type ListTaskEventsOptions,
  type TaskEventRow,
} from "../repositories/task-events";
import type { AppendTaskEventInput } from "../domain/task-events";

const log = childLogger("services:tasks:events");

export async function appendTaskEvent(
  input: AppendTaskEventInput,
): Promise<TaskEventRow> {
  return appendTaskEventRepo(input);
}

export async function appendTaskEventBestEffort(
  input: AppendTaskEventInput,
): Promise<void> {
  try {
    await appendTaskEventRepo(input);
  } catch (err) {
    log.warn(
      { err, taskId: input.taskId, eventType: input.eventType },
      "task_event append failed (best-effort)",
    );
  }
}

export async function listTaskEvents(
  taskId: string,
  opts: ListTaskEventsOptions = {},
): Promise<TaskEventRow[]> {
  return listTaskEventsRepo(taskId, opts);
}
