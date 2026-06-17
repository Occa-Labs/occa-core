// Drizzle access for `routines` and `routine_triggers`. The route layer
// orchestrates (validation, cron computation); this layer only reads and
// writes rows. The one exception is `rollDueCronTriggersForward`, which
// uses the pure `computeNextRun` helper so both the HTTP and CEO-marker
// resume paths share identical roll-forward behaviour.

import { and, eq, inArray } from "drizzle-orm";
import { deployments, routineTriggers, routines } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { computeNextRun } from "../domain/cron";

export type RoutineRow = typeof routines.$inferSelect;
export type RoutineTriggerRow = typeof routineTriggers.$inferSelect;

// A trigger ready to persist — `nextRunAt` is computed by the caller.
export interface TriggerInsert {
  kind: string;
  label: string | null;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string | null;
  nextRunAt: Date | null;
}

export interface RoutineInsert {
  title: string;
  description: string | null;
  assigneeDeploymentId: string;
  priority: string;
}

// Settable subsets for the PATCH endpoints — keeps the route layer free
// of the Drizzle insert type.
export interface RoutinePatch {
  title?: string;
  description?: string | null;
  priority?: string;
  status?: string;
  assigneeDeploymentId?: string;
}

export interface TriggerPatch {
  label?: string | null;
  enabled?: boolean;
  cronExpression?: string | null;
  timezone?: string | null;
  nextRunAt?: Date | null;
}

export async function listRoutines(companyId: string): Promise<RoutineRow[]> {
  return db.select().from(routines).where(eq(routines.companyId, companyId));
}

export async function listTriggers(
  routineIds: string[],
): Promise<RoutineTriggerRow[]> {
  if (routineIds.length === 0) return [];
  return db
    .select()
    .from(routineTriggers)
    .where(inArray(routineTriggers.routineId, routineIds));
}

export async function listTriggersForRoutine(
  routineId: string,
): Promise<RoutineTriggerRow[]> {
  return db
    .select()
    .from(routineTriggers)
    .where(eq(routineTriggers.routineId, routineId));
}

export async function loadRoutineRow(
  companyId: string,
  routineId: string,
): Promise<RoutineRow | undefined> {
  const [row] = await db
    .select()
    .from(routines)
    .where(and(eq(routines.id, routineId), eq(routines.companyId, companyId)))
    .limit(1);
  return row;
}

export async function createRoutineWithTriggers(
  companyId: string,
  routine: RoutineInsert,
  triggers: TriggerInsert[],
): Promise<string> {
  return db.transaction(async (tx) => {
    const [rtn] = await tx
      .insert(routines)
      .values({
        companyId,
        title: routine.title,
        description: routine.description,
        assigneeDeploymentId: routine.assigneeDeploymentId,
        priority: routine.priority,
      })
      .returning({ id: routines.id });
    for (const t of triggers) {
      await tx.insert(routineTriggers).values({
        routineId: rtn.id,
        kind: t.kind,
        label: t.label,
        enabled: t.enabled,
        cronExpression: t.cronExpression,
        timezone: t.timezone,
        nextRunAt: t.nextRunAt,
      });
    }
    return rtn.id;
  });
}

export async function updateRoutine(
  companyId: string,
  routineId: string,
  patch: RoutinePatch,
): Promise<RoutineRow | undefined> {
  const [row] = await db
    .update(routines)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(routines.id, routineId), eq(routines.companyId, companyId)))
    .returning();
  return row;
}

export async function deleteRoutine(
  companyId: string,
  routineId: string,
): Promise<boolean> {
  const [row] = await db
    .delete(routines)
    .where(and(eq(routines.id, routineId), eq(routines.companyId, companyId)))
    .returning({ id: routines.id });
  return !!row;
}

// Marks every enabled cron trigger of a routine due now, so the
// scheduler fires it on its next tick (a manual "Run now").
export async function markTriggersDue(routineId: string): Promise<void> {
  await db
    .update(routineTriggers)
    .set({ nextRunAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(routineTriggers.routineId, routineId),
        eq(routineTriggers.kind, "cron"),
        eq(routineTriggers.enabled, true),
      ),
    );
}

export async function ownsRoutine(
  companyId: string,
  routineId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: routines.id })
    .from(routines)
    .where(and(eq(routines.id, routineId), eq(routines.companyId, companyId)))
    .limit(1);
  return !!row;
}

export async function verifyAssignee(
  companyId: string,
  deploymentId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.id, deploymentId),
        eq(deployments.companyId, companyId),
      ),
    )
    .limit(1);
  return !!row;
}

export async function insertTrigger(
  routineId: string,
  t: TriggerInsert,
): Promise<RoutineTriggerRow> {
  const [row] = await db
    .insert(routineTriggers)
    .values({
      routineId,
      kind: t.kind,
      label: t.label,
      enabled: t.enabled,
      cronExpression: t.cronExpression,
      timezone: t.timezone,
      nextRunAt: t.nextRunAt,
    })
    .returning();
  return row;
}

export async function updateTrigger(
  routineId: string,
  triggerId: string,
  patch: TriggerPatch,
): Promise<RoutineTriggerRow | undefined> {
  const [row] = await db
    .update(routineTriggers)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(routineTriggers.id, triggerId),
        eq(routineTriggers.routineId, routineId),
      ),
    )
    .returning();
  return row;
}

// Resume cleanup: advance any past-due cron trigger to its next future
// slot. While a routine is paused the scheduler skips it but leaves
// next_run_at frozen at a now-elapsed time; without this, the next sweep
// after resume sees it as overdue and fires an unwanted catch-up run.
// No-op for interval/manual triggers and for triggers already in the future.
export async function rollDueCronTriggersForward(
  routineId: string,
): Promise<void> {
  const now = new Date();
  const triggers = await listTriggersForRoutine(routineId);
  for (const t of triggers) {
    if (
      t.kind === "cron" &&
      t.enabled &&
      t.cronExpression &&
      t.nextRunAt &&
      t.nextRunAt <= now
    ) {
      await db
        .update(routineTriggers)
        .set({
          nextRunAt: computeNextRun(t.cronExpression, t.timezone ?? null),
          updatedAt: new Date(),
        })
        .where(eq(routineTriggers.id, t.id));
    }
  }
}

export async function deleteTrigger(
  routineId: string,
  triggerId: string,
): Promise<boolean> {
  const [row] = await db
    .delete(routineTriggers)
    .where(
      and(
        eq(routineTriggers.id, triggerId),
        eq(routineTriggers.routineId, routineId),
      ),
    )
    .returning({ id: routineTriggers.id });
  return !!row;
}
