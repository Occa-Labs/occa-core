import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { db } from "../../../infra/database/client";
import { tasks, traces } from "@occa/shared/schema";
import { enqueueTaskDispatch } from "../../../infra/queue/task-worker";
import { childLogger } from "../../../lib/logger";

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

// Re-dispatch tasks that have an agent assigned but no live run — reverted to
// `todo` by the reaper (crash/restart) or never picked up. With `idleMs` set,
// only tasks untouched that long are swept, so the periodic call never races a
// task that is about to dispatch normally.
//
// `dedupe: false` is the crux. A crashed run leaves its `task.dispatch` job
// marked `active` (singletonKey = taskId) until pg-boss expires it ~15 min
// later, so a plain re-enqueue is silently dropped by the dedup — exactly how
// a task gets stranded in `todo`. A fresh key sidesteps that; dispatchTask
// re-checks dispatchability, so a late retry of the stale job is a no-op.
export async function enqueuePendingTasks(opts?: {
  idleMs?: number;
}): Promise<void> {
  const conditions = [
    eq(tasks.status, "todo"),
    isNotNull(tasks.assignedDeploymentId),
    isNull(tasks.linkedTraceId),
  ];
  if (opts?.idleMs != null) {
    conditions.push(lt(tasks.updatedAt, new Date(Date.now() - opts.idleMs)));
  }

  const pending = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(...conditions));

  if (pending.length === 0) return;

  let enqueued = 0;
  for (const row of pending) {
    try {
      await enqueueTaskDispatch(row.id, { dedupe: false });
      enqueued++;
    } catch (err) {
      log.error({ err }, `[recover] enqueue failed for ${row.id}`);
    }
  }
  log.info(`[recover] re-dispatched ${enqueued}/${pending.length} task(s)`);
}

// A task normally leaves `todo` within seconds of dispatch. One sitting in
// `todo` with an agent but no trace for minutes is stuck — boot recovery
// missed it, or a stale job's dedup ate its re-enqueue. Sweep periodically so
// no agent is ever silently parked; this is the safety net beyond boot.
const STUCK_TASK_IDLE_MS = 3 * 60 * 1000;
const SWEEP_INTERVAL_MS = 2 * 60 * 1000;

export function startStuckTaskSweep(): () => void {
  const timer = setInterval(() => {
    void enqueuePendingTasks({ idleMs: STUCK_TASK_IDLE_MS }).catch((err) =>
      log.error({ err }, "[recover] stuck-task sweep failed"),
    );
  }, SWEEP_INTERVAL_MS);
  log.info("[recover] stuck-task sweep started (every 2m, idle >= 3m)");
  return () => clearInterval(timer);
}
