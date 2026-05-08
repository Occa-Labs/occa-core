// Drizzle access for `task_comments`. Mention parsing + wake-on-mention
// belong in the service layer; this file only owns row CRUD.

import { and, eq, inArray } from "drizzle-orm";
import {
  agentIdentities,
  deployments,
  taskComments,
} from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type TaskCommentRow = typeof taskComments.$inferSelect;

export interface InsertCommentInput {
  taskId: string;
  companyId: string;
  authorDeploymentId: string | null;
  authorUserId: string | null;
  body: string;
  mentions: string[];
}

export async function insertTaskComment(
  input: InsertCommentInput,
): Promise<TaskCommentRow> {
  const [row] = await db
    .insert(taskComments)
    .values({
      taskId: input.taskId,
      companyId: input.companyId,
      authorDeploymentId: input.authorDeploymentId,
      authorUserId: input.authorUserId,
      body: input.body,
      mentions: input.mentions,
    })
    .returning();
  return row;
}

export async function listTaskCommentsByTask(
  taskId: string,
  companyId: string,
): Promise<TaskCommentRow[]> {
  return db
    .select()
    .from(taskComments)
    .where(
      and(
        eq(taskComments.taskId, taskId),
        eq(taskComments.companyId, companyId),
      ),
    )
    .orderBy(taskComments.createdAt);
}

// Hydration helper — given a list of deployment ids, returns id → name.
export async function deploymentNameMap(
  deploymentIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (deploymentIds.length === 0) return map;
  const rows = await db
    .select({ id: deployments.id, name: agentIdentities.name })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(inArray(deployments.id, deploymentIds));
  for (const r of rows) map.set(r.id, r.name);
  return map;
}

// Per-company mention resolution helper — joins deployments to identities
// so the service can match @<name> tokens against deployment names.
export async function listCompanyDeploymentNames(
  companyId: string,
): Promise<Array<{ id: string; name: string }>> {
  return db
    .select({ id: deployments.id, name: agentIdentities.name })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(eq(deployments.companyId, companyId));
}
