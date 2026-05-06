import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { db } from "../infra/database/client";
import { tasks, traces } from "@occa/shared/schema";
import { enqueueTaskDispatch } from "../infra/queue/task-worker";
import { childLogger } from "../lib/logger";

const log = childLogger("reaper");

// On server boot, fail any trace that was still "running" (dispatcher died
// mid-flight due to crash or restart) and revert its task back to todo so the
// user can reassign/retry.
export async function reapOrphans(): Promise<void> {
  const now = new Date();

  const failedTraces = await db
    .update(traces)
    .set({
      status: "failed",
      finishedAt: now,
      error: ERROR_CODES.SERVER_RESTART,
      errorCode: "server_restart",
      updatedAt: now,
    })
    .where(eq(traces.status, "running"))
    .returning({ id: traces.id });

  const revertedTasks = await db
    .update(tasks)
    .set({
      status: "todo",
      linkedTraceId: null,
      updatedAt: now,
    })
    .where(and(eq(tasks.status, "in_progress"), isNotNull(tasks.linkedTraceId)))
    .returning({ id: tasks.id });

  if (failedTraces.length > 0 || revertedTasks.length > 0) {
    log.info(
      `[reaper] failed ${failedTraces.length} orphan trace(s), reverted ${revertedTasks.length} orphan task(s)`,
    );
  }
}

// Enqueue any task that has an agent assigned but never got picked up by the
// worker. Covers two cases:
//   1. Tasks created before pg-boss existed (legacy fire-and-forget could fail
//      silently — job was never persisted).
//   2. Tasks reverted by the reaper above — user expects auto-retry on restart.
//
// Safe to run repeatedly: pg-boss `singletonKey: taskId` dedups against any
// active/queued job, so this is idempotent.
export async function enqueuePendingTasks(): Promise<void> {
  const pending = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "todo"),
        isNotNull(tasks.assignedDeploymentId),
        isNull(tasks.linkedTraceId),
      ),
    );

  if (pending.length === 0) return;

  let enqueued = 0;
  for (const row of pending) {
    try {
      await enqueueTaskDispatch(row.id);
      enqueued++;
    } catch (err) {
      log.error({ err }, `[bootstrap] enqueue failed for ${row.id}`);
    }
  }
  log.info(
    `[bootstrap] enqueued ${enqueued}/${pending.length} pending task(s)`,
  );
}
