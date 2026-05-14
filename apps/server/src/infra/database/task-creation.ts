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

// Drizzle exposes the tx executor as the first param of the transaction
// callback. Captured here so callers (EmitFollowUp, etc.) can pass an
// existing tx to fold task creation into a larger atomic unit. Nesting
// a fresh db.transaction inside another would break atomicity since
// Postgres has no real nested transactions.
export type TaskTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  // Set when the task originates from a CEO chat turn (DELEGATE or
  // CREATE_TASK emitted in chat-mode). Drives the chat-synthesis
  // callback in cascade — when the task completes, the synthesized
  // reply lands on this user's CEO chat thread. Null for tasks born
  // from nested DELEGATE inside another task, manual UI creation, or
  // EmitFollowUp.
  originatingUserId?: string | null;
}

async function insertWithCompanyLock(
  tx: TaskTx,
  input: CreateTaskRecordInput,
): Promise<TaskRow> {
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
      originatingUserId: input.originatingUserId ?? null,
    })
    .returning();
  return row;
}

export async function createTaskRecord(
  input: CreateTaskRecordInput,
  existingTx?: TaskTx,
): Promise<TaskRow> {
  if (existingTx) return insertWithCompanyLock(existingTx, input);
  return db.transaction((tx) => insertWithCompanyLock(tx, input));
}
