// Polls task_events for recent task_status_changed:done transitions
// and enqueues workflow.evaluate jobs. Single hook point that covers
// BOTH the server dispatch path (closeSucceededTrace) AND the worker
// path (task-sync.syncTaskOnTraceSucceeded) without coupling either
// caller to the workflow engine.
//
// Dedup is layered: the pg-boss queue uses singletonKey=taskId with
// the `exclusive` policy, and the engine itself checks for an existing
// WorkflowExecuted audit row before evaluating. Re-enqueues from the
// poller are therefore harmless.

import { and, eq, gt, sql } from "drizzle-orm";
import { taskEvents } from "@occa/shared/schema";
import { db } from "../infra/database/client";
import { childLogger } from "../lib/logger";
import { enqueueWorkflowEvaluation } from "../infra/queue/workflow-worker";

const log = childLogger("workflow-trigger-poller");

// Cadence chosen so a typical task → workflow latency is well under a
// minute. Lower if users complain; higher if poller load shows up in
// DB metrics.
const POLL_INTERVAL_MS = 10_000;

// Cap how far back the poller looks on first tick after a server
// restart. Beyond this, missed events are eventually rediscovered by
// future done transitions of the same task (rare) or stay missed —
// acceptable since workflow evaluation is best-effort.
const BOOTSTRAP_LOOKBACK_SECONDS = 5 * 60;

// Cursor stored as a timestamp rather than an event id — the row
// referenced by an id can be cascade-deleted with its parent task,
// which silently breaks an id-based subquery cursor (the subquery
// returns NULL, `created_at > NULL` is always false, and the poller
// stops finding events forever). Timestamps survive row deletes.
let lastSeenCreatedAt: Date | null = null;
let timer: NodeJS.Timeout | null = null;
let inFlight = false;

interface DoneEventRow {
  id: string;
  taskId: string;
  createdAt: Date;
}

async function fetchNewDoneEvents(): Promise<DoneEventRow[]> {
  const baseCondition = and(
    eq(taskEvents.eventType, "task_status_changed"),
    sql`${taskEvents.payload}->>'to' = 'done'`,
  );
  const conditions = lastSeenCreatedAt
    ? and(
        baseCondition,
        // 300ms backstep forgives clock-skew between `now()` and the
        // inserted-row timestamps. Dedup is handled by pg-boss's
        // singletonKey + the engine's alreadyEvaluated audit-row
        // check, so a re-enqueue at the boundary is harmless.
        gt(
          taskEvents.createdAt,
          new Date(lastSeenCreatedAt.getTime() - 300),
        ),
      )
    : and(
        baseCondition,
        sql`${taskEvents.createdAt} >= now() - INTERVAL '${sql.raw(String(BOOTSTRAP_LOOKBACK_SECONDS))} seconds'`,
      );

  const rows = await db
    .select({
      id: taskEvents.id,
      taskId: taskEvents.taskId,
      createdAt: taskEvents.createdAt,
    })
    .from(taskEvents)
    .where(conditions)
    .orderBy(taskEvents.createdAt)
    .limit(500);

  return rows;
}

async function pollOnce(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const events = await fetchNewDoneEvents();
    if (events.length === 0) return;

    // Dedup tasks within this batch — same task with multiple done
    // events in quick succession only needs one enqueue.
    const seenTaskIds = new Set<string>();
    for (const ev of events) {
      if (seenTaskIds.has(ev.taskId)) continue;
      seenTaskIds.add(ev.taskId);
      try {
        await enqueueWorkflowEvaluation(ev.taskId);
      } catch (err) {
        log.warn({ err, taskId: ev.taskId }, "enqueue failed; will retry next tick");
      }
    }

    lastSeenCreatedAt = events[events.length - 1].createdAt;
    log.debug(
      { processed: seenTaskIds.size, lastSeenCreatedAt },
      "poll tick processed done events",
    );
  } catch (err) {
    log.error({ err }, "poller tick failed");
  } finally {
    inFlight = false;
  }
}

export function startWorkflowTriggerPoller(): void {
  if (timer) return;
  log.info(
    { intervalMs: POLL_INTERVAL_MS, lookbackSeconds: BOOTSTRAP_LOOKBACK_SECONDS },
    "workflow trigger poller starting",
  );
  // Fire once immediately so a queued workflow doesn't have to wait a
  // full interval on cold boot.
  void pollOnce();
  timer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
}

export function stopWorkflowTriggerPoller(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  log.info("workflow trigger poller stopped");
}
