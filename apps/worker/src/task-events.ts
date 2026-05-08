// Worker-side binding of the shared task-events helper. Append semantics
// + types live in `@occa/shared/task-events`; this file just plugs the
// worker's drizzle client and re-exports for the existing import paths.

import {
  appendTaskEvent as appendTaskEventShared,
  appendTaskEventBestEffort as appendTaskEventBestEffortShared,
  type AppendTaskEventInput,
  type TaskEventRow,
} from "@occa/shared/task-events";
import { db } from "./db";

export type {
  AppendTaskEventInput,
  TaskEventActorType,
  TaskEventType,
} from "@occa/shared/task-events";

export async function appendTaskEvent(
  input: AppendTaskEventInput,
): Promise<TaskEventRow> {
  return appendTaskEventShared(db, input);
}

export async function appendTaskEventBestEffort(
  input: AppendTaskEventInput,
): Promise<void> {
  return appendTaskEventBestEffortShared(db, input, (err, inp) => {
    console.error(
      "[worker:task-events] append failed",
      inp.taskId,
      inp.eventType,
      err instanceof Error ? err.message : err,
    );
  });
}
