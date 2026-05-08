// Drizzle access for `workflows`. Single-feature ownership: nothing
// else in the server reads or writes this table today, so all access
// flows through here.

import { and, asc, eq } from "drizzle-orm";
import { workflows } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import type { WorkflowDefinition } from "@occa/shared/workflows";

export type WorkflowRow = typeof workflows.$inferSelect;

export interface InsertWorkflowInput {
  companyId: string;
  yamlId: string;
  name: string;
  description: string | null;
  yamlText: string;
  parsedDefinition: WorkflowDefinition;
  enabled: boolean;
}

export interface UpdateWorkflowInput {
  yamlId?: string;
  name?: string;
  description?: string | null;
  yamlText?: string;
  parsedDefinition?: WorkflowDefinition;
  enabled?: boolean;
}

export async function listWorkflowsForCompany(
  companyId: string,
): Promise<WorkflowRow[]> {
  return db
    .select()
    .from(workflows)
    .where(eq(workflows.companyId, companyId))
    .orderBy(asc(workflows.createdAt));
}

export async function findWorkflowInCompany(
  workflowId: string,
  companyId: string,
): Promise<WorkflowRow | null> {
  const [row] = await db
    .select()
    .from(workflows)
    .where(
      and(eq(workflows.id, workflowId), eq(workflows.companyId, companyId)),
    )
    .limit(1);
  return row ?? null;
}

export async function findWorkflowByYamlId(
  yamlId: string,
  companyId: string,
): Promise<WorkflowRow | null> {
  const [row] = await db
    .select()
    .from(workflows)
    .where(
      and(eq(workflows.companyId, companyId), eq(workflows.yamlId, yamlId)),
    )
    .limit(1);
  return row ?? null;
}

export async function insertWorkflow(
  input: InsertWorkflowInput,
): Promise<WorkflowRow> {
  const [row] = await db
    .insert(workflows)
    .values({
      companyId: input.companyId,
      yamlId: input.yamlId,
      name: input.name,
      description: input.description,
      yamlText: input.yamlText,
      parsedDefinition: input.parsedDefinition,
      enabled: input.enabled,
    })
    .returning();
  return row;
}

export async function updateWorkflow(
  workflowId: string,
  companyId: string,
  patch: UpdateWorkflowInput,
): Promise<WorkflowRow | null> {
  const [row] = await db
    .update(workflows)
    .set({
      ...(patch.yamlId !== undefined ? { yamlId: patch.yamlId } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : {}),
      ...(patch.yamlText !== undefined ? { yamlText: patch.yamlText } : {}),
      ...(patch.parsedDefinition !== undefined
        ? { parsedDefinition: patch.parsedDefinition }
        : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(eq(workflows.id, workflowId), eq(workflows.companyId, companyId)),
    )
    .returning();
  return row ?? null;
}

export async function deleteWorkflow(
  workflowId: string,
  companyId: string,
): Promise<boolean> {
  const rows = await db
    .delete(workflows)
    .where(
      and(eq(workflows.id, workflowId), eq(workflows.companyId, companyId)),
    )
    .returning({ id: workflows.id });
  return rows.length > 0;
}
