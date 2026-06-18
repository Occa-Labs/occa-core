// Local route helpers — TaskRow → DTO and the user-company lookup.
// Not exported beyond this folder.

import { and, eq, isNull } from "drizzle-orm";
import { companies } from "@occa/shared/schema";
import type {
  ContentBlock,
  EffortLevel,
  TaskDTO,
  TaskPriority,
  TaskStatus,
  TaskType,
} from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import type { TaskRow } from "../repositories/tasks";

// Returns the user's primary user-company (kind='user', not soft-
// deleted). Mirrors the same helper duplicated in routes/routines and
// features/skills — kept local because it's an ownership check
// specific to the user-JWT route surface.
export async function userCompanyId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(
        eq(companies.ownerUserId, userId),
        eq(companies.kind, "user"),
        isNull(companies.deletedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

export function toTaskDTO(
  row: TaskRow,
  agentName: string | null,
  workflowYamlId: string | null = null,
): TaskDTO {
  return {
    id: row.id,
    companyId: row.companyId,
    taskNumber: row.taskNumber,
    assignedAgentId: row.assignedDeploymentId,
    assignedAgentName: agentName,
    title: row.title,
    blocks: (row.blocks as ContentBlock[]) ?? [],
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    taskType: row.taskType as TaskType,
    effortLevel: row.effortLevel as EffortLevel,
    tags: row.tags ?? [],
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    linkedTraceId: row.linkedTraceId ?? null,
    resultUri: row.resultUri ?? null,
    parentTaskId: row.parentTaskId ?? null,
    blockedByTaskIds: row.blockedByTaskIds ?? [],
    createdByUserId: row.createdByUserId ?? null,
    createdByAgentId: row.createdByDeploymentId ?? null,
    acceptanceCriteria: row.acceptanceCriteria ?? null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    archiveReason: row.archiveReason ?? null,
    errorCode: row.errorCode ?? null,
    workflowRunId: row.workflowRunId ?? null,
    workflowStepIndex: row.workflowStepIndex ?? null,
    workflowYamlId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
