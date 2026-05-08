// Atomic task insert primitive. Locks the company row to serialise
// per-company taskNumber allocation against concurrent inserts, then
// inserts the task with the next number.
//
// Lives at the infra/database layer because two unrelated features need
// it (features/tasks user-create routes; features/agents EmitFollowUp
// agent action; legacy routes/approvals delegate-spawn) and CLAUDE.md
// forbids cross-feature imports. Layer rules: infra/ → lib/ + drizzle —
// keeps this file dependency-light and reusable.

import { eq } from "drizzle-orm";
import { companies, tasks } from "@occa/shared/schema";
import type { ContentBlock, TaskStatus } from "@occa/shared/types";
import { db } from "./client";
import { nextTaskNumber } from "./task-numbers";

export type TaskRow = typeof tasks.$inferSelect;

export interface CreateTaskRecordInput {
  companyId: string;
  title: string;
  blocks: ContentBlock[];
  status: TaskStatus;
  priority: string;
  taskType: string;
  effortLevel: string;
  tags: string[];
  dueDate: Date | null;
  assignedDeploymentId: string | null;
  parentTaskId: string | null;
  createdByUserId: string | null;
  createdByDeploymentId: string | null;
  acceptanceCriteria: string | null;
}

export async function createTaskRecord(
  input: CreateTaskRecordInput,
): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .for("update");
    const taskNumber = await nextTaskNumber(tx, input.companyId);
    const [row] = await tx
      .insert(tasks)
      .values({
        companyId: input.companyId,
        taskNumber,
        title: input.title,
        blocks: input.blocks,
        status: input.status,
        priority: input.priority,
        taskType: input.taskType,
        effortLevel: input.effortLevel,
        tags: input.tags,
        dueDate: input.dueDate,
        assignedDeploymentId: input.assignedDeploymentId,
        parentTaskId: input.parentTaskId,
        createdByUserId: input.createdByUserId,
        createdByDeploymentId: input.createdByDeploymentId,
        acceptanceCriteria: input.acceptanceCriteria,
      })
      .returning();
    return row;
  });
}
