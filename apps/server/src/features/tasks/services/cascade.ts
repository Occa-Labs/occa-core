// L2 task-graph cascade. When a task transitions to `done`:
//   1. unblockDependents — any task with this in its blocked_by_task_ids
//      gets the entry removed; if their list goes empty AND they were
//      parked in `blocked`, flip back to `todo` + dispatch.
//   2. cascadeOnTaskDone — if this task has a parent AND all siblings
//      are also done, wake the parent so its agent can synthesize.
//
// Mirror of the autonomy doc §3.1 `task.children_completed` event.

import { childLogger } from "../../../lib/logger";
import { enqueueTaskDispatch } from "../../../infra/queue/task-worker";
import {
  findTaskById,
  listDependents,
  listPendingSiblings,
  unblockOne,
  updateTask,
} from "../repositories/tasks";
import { appendTaskEventBestEffort } from "./events";

const log = childLogger("services:tasks:cascade");

export interface CascadeOnTaskDoneInput {
  taskId: string;
}

export type CascadeReason =
  | "no_parent"
  | "siblings_pending"
  | "parent_already_done"
  | "parent_unassigned"
  | "parent_not_found"
  | "woken";

export interface CascadeOnTaskDoneResult {
  parentWoken: boolean;
  parentTaskId: string | null;
  reason: CascadeReason;
}

async function unblockDependents(taskId: string): Promise<string[]> {
  const dependents = await listDependents(taskId);
  if (dependents.length === 0) return [];
  const woken: string[] = [];
  for (const dep of dependents) {
    const after = await unblockOne(dep.id, taskId);
    if (!after) continue;
    const blockersEmpty = after.blockedByTaskIds.length === 0;
    if (
      !blockersEmpty ||
      dep.status !== "blocked" ||
      dep.assignedDeploymentId === null
    ) {
      continue;
    }
    await updateTask(dep.id, { status: "todo", linkedTraceId: null });
    void appendTaskEventBestEffort({
      companyId: dep.companyId,
      taskId: dep.id,
      eventType: "task_unblocked",
      actorType: "system",
      actorId: "system",
      payload: { by: "cascade", lastBlockerTaskId: taskId },
    });
    void appendTaskEventBestEffort({
      companyId: dep.companyId,
      taskId: dep.id,
      eventType: "task_status_changed",
      actorType: "system",
      actorId: "system",
      payload: { from: "blocked", to: "todo", reason: "blockers_resolved" },
    });
    void enqueueTaskDispatch(dep.id).catch((err) => {
      log.error({ err, taskId: dep.id }, "unblock dispatch failed");
    });
    woken.push(dep.id);
    log.info(
      { taskId: dep.id, lastBlocker: taskId },
      "blockers resolved, dependent task woken",
    );
  }
  return woken;
}

export async function cascadeOnTaskDone(
  input: CascadeOnTaskDoneInput,
): Promise<CascadeOnTaskDoneResult> {
  // Run blockers_resolved in parallel with the parent check — they're
  // independent (a task can both have a parent and be a blocker).
  void unblockDependents(input.taskId).catch((err) => {
    log.error({ err, taskId: input.taskId }, "unblockDependents failed");
  });

  const task = await findTaskById(input.taskId);
  if (!task?.parentTaskId) {
    return { parentWoken: false, parentTaskId: null, reason: "no_parent" };
  }

  const pendingSiblings = await listPendingSiblings(task.parentTaskId);
  if (pendingSiblings.length > 0) {
    return {
      parentWoken: false,
      parentTaskId: task.parentTaskId,
      reason: "siblings_pending",
    };
  }

  const parent = await findTaskById(task.parentTaskId);
  if (!parent) {
    return {
      parentWoken: false,
      parentTaskId: task.parentTaskId,
      reason: "parent_not_found",
    };
  }
  if (!parent.assignedDeploymentId) {
    return {
      parentWoken: false,
      parentTaskId: parent.id,
      reason: "parent_unassigned",
    };
  }
  if (parent.status === "done") {
    return {
      parentWoken: false,
      parentTaskId: parent.id,
      reason: "parent_already_done",
    };
  }

  // The dispatcher's first-line guard refuses to launch on tasks already
  // `in_progress` with a linked trace; flipping to `todo` + clearing the
  // trace ref bypasses that cleanly. The agent's previous trace stays
  // in DB (history) — only the live linkage is cleared.
  await updateTask(parent.id, { status: "todo", linkedTraceId: null });

  void appendTaskEventBestEffort({
    companyId: task.companyId,
    taskId: parent.id,
    eventType: "task_status_changed",
    actorType: "system",
    actorId: "system",
    payload: {
      from: parent.status,
      to: "todo",
      reason: "child_completed",
      childTaskId: input.taskId,
    },
  });

  await enqueueTaskDispatch(parent.id);
  log.info(
    { parentTaskId: parent.id, childTaskId: input.taskId },
    "children_completed: parent woken",
  );

  return {
    parentWoken: true,
    parentTaskId: parent.id,
    reason: "woken",
  };
}
