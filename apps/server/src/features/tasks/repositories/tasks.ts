// Drizzle access for the `tasks` table. Routes/services only ever read
// or mutate tasks through these helpers — keeps Drizzle out of the rest
// of the feature.

import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  agentIdentities,
  deployments,
  tasks,
  traces,
  workflowRuns,
} from "@occa/shared/schema";
import type {
  TaskStatus,
  TaskUsageSummary,
  TraceUsage,
} from "@occa/shared/types";
import { db } from "../../../infra/database/client";

export type TaskRow = typeof tasks.$inferSelect;

export async function findTaskById(taskId: string): Promise<TaskRow | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return row ?? null;
}

// Map a set of workflow_run ids → their bound workflow yaml id, so a task
// list can label its workflow-run rows without a per-row lookup. Empty
// input short-circuits to an empty map.
export async function loadWorkflowYamlIdsForRuns(
  runIds: string[],
): Promise<Map<string, string>> {
  if (runIds.length === 0) return new Map();
  const rows = await db
    .select({ id: workflowRuns.id, yamlId: workflowRuns.workflowYamlId })
    .from(workflowRuns)
    .where(inArray(workflowRuns.id, runIds));
  return new Map(rows.map((r) => [r.id, r.yamlId]));
}

// Sum token/cost across every trace this task ran. Re-dispatches each open a
// new trace, so a task's true cost is the sum, not the latest run. Only
// traces that carried usage count toward `runs` (a timed-out run with null
// usageJson contributes nothing).
export async function sumTaskUsage(taskId: string): Promise<TaskUsageSummary> {
  const rows = await db
    .select({ usage: traces.usageJson })
    .from(traces)
    .where(eq(traces.taskId, taskId));
  const summary: TaskUsageSummary = {
    runs: 0,
    tokensIn: 0,
    tokensOut: 0,
    cachedTokensIn: 0,
    costCents: 0,
  };
  for (const r of rows) {
    const u = r.usage as TraceUsage | null;
    if (!u) continue;
    summary.runs += 1;
    summary.tokensIn += u.tokensIn ?? 0;
    summary.tokensOut += u.tokensOut ?? 0;
    summary.cachedTokensIn += u.cachedTokensIn ?? 0;
    summary.costCents += u.costCents ?? 0;
  }
  return summary;
}

export async function findTaskInCompany(
  taskId: string,
  companyId: string,
): Promise<TaskRow | null> {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.companyId, companyId)))
    .limit(1);
  return row ?? null;
}

export async function listTasksByCompany(
  companyId: string,
  opts: {
    /** Include archived rows alongside active ones. */
    includeArchived?: boolean;
    /** Return ONLY archived rows (the board's Archived column). */
    archivedOnly?: boolean;
    /** Restrict to a single status column. */
    status?: TaskStatus;
    /** Restrict to a set of statuses (the "Needs attention" column groups
     *  blocked + error). Mutually exclusive with `status`. */
    statusIn?: TaskStatus[];
    /** Page size. Omit for the full unbounded list (legacy callers). */
    limit?: number;
    /** Page offset, paired with `limit`. */
    offset?: number;
  } = {},
): Promise<TaskRow[]> {
  const conditions = [eq(tasks.companyId, companyId)];
  if (opts.archivedOnly) {
    conditions.push(sql`${tasks.archivedAt} IS NOT NULL`);
  } else if (!opts.includeArchived) {
    conditions.push(isNull(tasks.archivedAt));
  }
  if (opts.status) conditions.push(eq(tasks.status, opts.status));
  if (opts.statusIn && opts.statusIn.length > 0) {
    conditions.push(inArray(tasks.status, opts.statusIn));
  }

  let query = db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.updatedAt))
    .$dynamic();
  if (opts.limit != null) query = query.limit(opts.limit);
  if (opts.offset != null) query = query.offset(opts.offset);
  return query;
}

// Per-status counts for the board column headers. One grouped aggregate over
// the active partial index, plus a single archived total — cheap regardless of
// how many tasks exist, so headers stay accurate while cards are paginated.
export async function taskStatusCounts(
  companyId: string,
): Promise<{ byStatus: Record<string, number>; archived: number }> {
  const activeRows = await db
    .select({ status: tasks.status, count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.companyId, companyId), isNull(tasks.archivedAt)))
    .groupBy(tasks.status);

  const [archivedRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(
      and(
        eq(tasks.companyId, companyId),
        sql`${tasks.archivedAt} IS NOT NULL`,
      ),
    );

  const byStatus: Record<string, number> = {};
  for (const row of activeRows) byStatus[row.status] = row.count;
  return { byStatus, archived: archivedRow?.count ?? 0 };
}

// Most-recently-completed tasks for a company. Used by the chat surface
// to surface a "recent work" snapshot in the context preamble — gives
// the CEO a feel for what the team has shipped without dragging in full
// task bodies. Limit is enforced by caller; we just order + cap.
export async function listRecentDoneTasksByCompany(args: {
  companyId: string;
  limit: number;
}): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.companyId, args.companyId),
        eq(tasks.status, "done"),
        isNull(tasks.archivedAt),
      ),
    )
    .orderBy(desc(tasks.updatedAt))
    .limit(args.limit);
}

export async function archiveTask(
  taskId: string,
  reason: string | null,
): Promise<TaskRow | null> {
  const [row] = await db
    .update(tasks)
    .set({
      archivedAt: new Date(),
      archiveReason: reason,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), isNull(tasks.archivedAt)))
    .returning();
  return row ?? null;
}

export async function unarchiveTask(taskId: string): Promise<TaskRow | null> {
  const [row] = await db
    .update(tasks)
    .set({
      archivedAt: null,
      archiveReason: null,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), sql`${tasks.archivedAt} IS NOT NULL`))
    .returning();
  return row ?? null;
}

export async function deleteTaskInCompany(
  taskId: string,
  companyId: string,
): Promise<TaskRow | null> {
  const [row] = await db
    .delete(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.companyId, companyId)))
    .returning();
  return row ?? null;
}

// Bulk archive every active (non-archived) task in `companyId` whose status
// is in `statuses`. Mirrors single archive: soft-state, leaves rows in place.
// Returns the count affected. Empty `statuses` is a no-op.
export async function bulkArchiveByStatus(
  companyId: string,
  statuses: TaskStatus[],
): Promise<number> {
  if (statuses.length === 0) return 0;
  const rows = await db
    .update(tasks)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(tasks.companyId, companyId),
        inArray(tasks.status, statuses),
        isNull(tasks.archivedAt),
      ),
    )
    .returning({ id: tasks.id });
  return rows.length;
}

// Bulk hard-delete every active (non-archived) task in `companyId` whose
// status is in `statuses` — same row removal as single delete, applied to a
// set. Returns the count deleted. Empty `statuses` is a no-op.
export async function bulkDeleteByStatus(
  companyId: string,
  statuses: TaskStatus[],
): Promise<number> {
  if (statuses.length === 0) return 0;
  const rows = await db
    .delete(tasks)
    .where(
      and(
        eq(tasks.companyId, companyId),
        inArray(tasks.status, statuses),
        isNull(tasks.archivedAt),
      ),
    )
    .returning({ id: tasks.id });
  return rows.length;
}

export type UpdateTaskFields = Partial<typeof tasks.$inferInsert>;

export async function updateTask(
  taskId: string,
  fields: UpdateTaskFields,
): Promise<TaskRow | null> {
  const [row] = await db
    .update(tasks)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
    .returning();
  return row ?? null;
}

export async function setTaskStatus(
  taskId: string,
  fromStatuses: TaskStatus[],
  toStatus: TaskStatus,
): Promise<void> {
  await db
    .update(tasks)
    .set({ status: toStatus, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, fromStatuses)));
}

export async function setLinkedTrace(
  taskId: string,
  traceId: string | null,
): Promise<void> {
  await db
    .update(tasks)
    .set({ linkedTraceId: traceId, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
}

export async function listChildTasks(
  parentTaskId: string,
): Promise<{ id: string; status: string }[]> {
  return db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId));
}

// Returns siblings that have NOT reached a settled state. With the
// post-2026-05-14 cascade policy, both `done` and `review` count as
// settled (cascade fires for either, and review surfaces to the user
// via synthesis as "wants your review"). Anything else (`todo`,
// `in_progress`, `blocked`) keeps the parent asleep.
export async function listPendingSiblings(
  parentTaskId: string,
): Promise<{ id: string; status: string }[]> {
  return db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(
      and(
        eq(tasks.parentTaskId, parentTaskId),
        ne(tasks.status, "done"),
        ne(tasks.status, "review"),
      ),
    );
}

// Returns deps that have `taskId` listed in their blocked_by_task_ids array.
export async function listDependents(taskId: string): Promise<
  Array<{
    id: string;
    companyId: string;
    status: string;
    assignedDeploymentId: string | null;
    blockedByTaskIds: string[];
  }>
> {
  return db
    .select({
      id: tasks.id,
      companyId: tasks.companyId,
      status: tasks.status,
      assignedDeploymentId: tasks.assignedDeploymentId,
      blockedByTaskIds: tasks.blockedByTaskIds,
    })
    .from(tasks)
    .where(sql`${taskId}::uuid = ANY(${tasks.blockedByTaskIds})`);
}

// Strips a task from a dependent's blockedByTaskIds and returns the
// updated array length so the caller can decide whether to wake.
export async function unblockOne(
  dependentId: string,
  blockerToRemove: string,
): Promise<{ id: string; blockedByTaskIds: string[] } | null> {
  const [row] = await db
    .update(tasks)
    .set({
      blockedByTaskIds: sql`array_remove(${tasks.blockedByTaskIds}, ${blockerToRemove}::uuid)`,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, dependentId))
    .returning({
      id: tasks.id,
      blockedByTaskIds: tasks.blockedByTaskIds,
    });
  return row ?? null;
}

// Walks parentTaskId to root, counting hops. Used to enforce
// TASK_CHAIN_MAX_DEPTH from agent-actions caps.
export async function computeTaskDepth(taskId: string): Promise<number> {
  const result = await db.execute<{ depth: number }>(sql`
    WITH RECURSIVE chain AS (
      SELECT id, parent_task_id, 0 AS depth
      FROM tasks
      WHERE id = ${taskId}::uuid
      UNION ALL
      SELECT t.id, t.parent_task_id, c.depth + 1
      FROM tasks t
      JOIN chain c ON t.id = c.parent_task_id
    )
    SELECT COALESCE(MAX(depth), 0)::int AS depth FROM chain
  `);
  return result.rows[0]?.depth ?? 0;
}

export async function countAgentEmittedChildren(
  parentTaskId: string,
  deploymentId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(
      and(
        eq(tasks.parentTaskId, parentTaskId),
        eq(tasks.createdByDeploymentId, deploymentId),
      ),
    );
  return row?.count ?? 0;
}

// Per-company id → name lookup for hydrating DTOs.
export async function agentNameMap(
  companyId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: deployments.id, name: agentIdentities.name })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(eq(deployments.companyId, companyId));
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.id, r.name);
  return map;
}

// Quick existence + scope check for an assigned deployment.
export async function deploymentInCompany(
  companyId: string,
  deploymentId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(eq(deployments.id, deploymentId), eq(deployments.companyId, companyId)),
    )
    .limit(1);
  return Boolean(row);
}

