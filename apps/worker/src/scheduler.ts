import { and, eq, inArray, sql } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import {
  routineRuns,
  routineTriggers,
  routines,
} from "@occa/shared/schema";
import { db } from "./db";
import { wakeup } from "./wakeup";

const TICK_INTERVAL_MS = 30_000;

function nextRunAt(
  cronExpression: string,
  timezone: string | null,
): Date | null {
  try {
    const iter = CronExpressionParser.parse(cronExpression, {
      tz: timezone ?? undefined,
    });
    return iter.next().toDate();
  } catch {
    return null;
  }
}

interface DueTrigger {
  triggerId: string;
  routineId: string;
  cronExpression: string | null;
  timezone: string | null;
  nextRunAt: Date | null;
  lastFiredAt: Date | null;
}

async function claimDueTriggers(): Promise<DueTrigger[]> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{
      trigger_id: string;
      routine_id: string;
      cron_expression: string | null;
      timezone: string | null;
      next_run_at: Date | null;
      last_fired_at: Date | null;
    }>(sql`
      SELECT t.id AS trigger_id,
             t.routine_id,
             t.cron_expression,
             t.timezone,
             t.next_run_at,
             t.last_fired_at
      FROM routine_triggers t
      JOIN routines r ON r.id = t.routine_id
      WHERE t.enabled = true
        AND t.kind = 'cron'
        AND t.next_run_at IS NOT NULL
        AND t.next_run_at <= now()
        AND r.status = 'active'
      ORDER BY t.next_run_at
      LIMIT 32
      FOR UPDATE OF t SKIP LOCKED
    `);

    if (rows.length === 0) return [] as DueTrigger[];

    const ids = rows.map((r) => r.trigger_id);
    const now = new Date();

    // Recompute next_run_at for each (individually so each gets its own cron).
    for (const r of rows) {
      const next =
        r.cron_expression !== null
          ? nextRunAt(r.cron_expression, r.timezone)
          : null;
      await tx
        .update(routineTriggers)
        .set({
          lastFiredAt: now,
          nextRunAt: next,
          updatedAt: now,
        })
        .where(eq(routineTriggers.id, r.trigger_id));
    }

    // Stamp parent routine lastTriggeredAt.
    const routineIds = Array.from(new Set(rows.map((r) => r.routine_id)));
    await tx
      .update(routines)
      .set({ lastTriggeredAt: now, updatedAt: now })
      .where(inArray(routines.id, routineIds));

    return rows.map(
      (r): DueTrigger => ({
        triggerId: r.trigger_id,
        routineId: r.routine_id,
        cronExpression: r.cron_expression,
        timezone: r.timezone,
        nextRunAt: r.next_run_at,
        lastFiredAt: r.last_fired_at,
      }),
    );
  });
}

async function fireTrigger(trigger: DueTrigger): Promise<void> {
  const [routine] = await db
    .select()
    .from(routines)
    .where(eq(routines.id, trigger.routineId))
    .limit(1);
  if (!routine) return;
  if (!routine.assigneeDeploymentId) {
    // No assignee — record as failed so we don't retry in a hot loop.
    await db.insert(routineRuns).values({
      routineId: routine.id,
      triggerId: trigger.triggerId,
      source: "cron",
      status: "failed",
      triggeredAt: new Date(),
      failureReason: "no_assignee",
    });
    return;
  }

  const firedAt = new Date();
  // Skip-missed catch-up: we just fire once for now. run_once_if_missed is
  // covered by the same single fire (the scheduler keeps advancing
  // nextRunAt by one cron step per tick).
  const idempotencyKey = `routine:${routine.id}:${trigger.triggerId}:${Math.floor(firedAt.getTime() / 1000)}`;

  try {
    const wake = await wakeup({
      agentId: routine.assigneeDeploymentId,
      source: "timer",
      triggerDetail: `routine:${routine.id}`,
      reason: `Routine: ${routine.title}`,
      wakePayload: {
        routineId: routine.id,
        triggerId: trigger.triggerId,
      },
      idempotencyKey,
      actor: { type: "system", id: null },
    });

    await db.insert(routineRuns).values({
      routineId: routine.id,
      triggerId: trigger.triggerId,
      source: "cron",
      status: wake.coalesced ? "coalesced" : "enqueued",
      triggeredAt: firedAt,
      idempotencyKey,
      coalescedIntoTraceId: wake.coalesced ? wake.traceId : null,
      triggerPayload: { traceId: wake.traceId },
    });

    if (!wake.coalesced) {
      await db
        .update(routines)
        .set({ lastEnqueuedAt: firedAt, updatedAt: firedAt })
        .where(eq(routines.id, routine.id));
    }
  } catch (err) {
    await db.insert(routineRuns).values({
      routineId: routine.id,
      triggerId: trigger.triggerId,
      source: "cron",
      status: "failed",
      triggeredAt: firedAt,
      idempotencyKey,
      failureReason: err instanceof Error ? err.message : String(err),
    });
  }
}

let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const due = await claimDueTriggers();
    for (const t of due) {
      try {
        await fireTrigger(t);
      } catch (err) {
        console.error(
          `[worker:scheduler] fire error trigger=${t.triggerId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } finally {
    running = false;
  }
}

// Backfill nextRunAt on triggers that are missing it (e.g. triggers added
// before this worker existed). Runs once on boot.
async function backfillMissingNextRun() {
  const triggers = await db
    .select()
    .from(routineTriggers)
    .where(
      and(
        eq(routineTriggers.enabled, true),
        eq(routineTriggers.kind, "cron"),
        // any nextRunAt that's null
      ),
    );
  for (const t of triggers) {
    if (t.nextRunAt !== null) continue;
    if (!t.cronExpression) continue;
    const n = nextRunAt(t.cronExpression, t.timezone);
    if (!n) continue;
    await db
      .update(routineTriggers)
      .set({ nextRunAt: n, updatedAt: new Date() })
      .where(eq(routineTriggers.id, t.id));
  }
}

export function startSchedulerLoop(): () => void {
  console.log(`[worker:scheduler] started (tick=${TICK_INTERVAL_MS}ms)`);
  void backfillMissingNextRun().catch((err) =>
    console.error(
      "[worker:scheduler] backfill error:",
      err instanceof Error ? err.message : err,
    ),
  );
  const handle = setInterval(() => {
    void tick().catch((err) => {
      console.error(
        "[worker:scheduler] tick error:",
        err instanceof Error ? err.message : err,
      );
    });
  }, TICK_INTERVAL_MS);
  return () => clearInterval(handle);
}
