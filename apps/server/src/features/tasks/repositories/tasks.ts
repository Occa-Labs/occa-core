// Drizzle access for the `tasks` table. Routes/services only ever read
// or mutate tasks through these helpers — keeps Drizzle out of the rest
// of the feature.

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  agentIdentities,
  deployments,
  tasks,
} from "@occa/shared/schema";
import type { TaskStatus } from "@occa/shared/types";
import { db } from "../../../infra/database/client";

export type TaskRow = typeof tasks.$inferSelect;

export async function findTaskById(taskId: string): Promise<TaskRow | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return row ?? null;
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

export async function listTasksByCompany(companyId: string): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.companyId, companyId))
    .orderBy(desc(tasks.updatedAt));
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

export async function listPendingSiblings(
  parentTaskId: string,
): Promise<{ id: string; status: string }[]> {
  return db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(
      and(eq(tasks.parentTaskId, parentTaskId), ne(tasks.status, "done")),
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

