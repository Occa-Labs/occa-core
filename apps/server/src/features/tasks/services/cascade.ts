// L2 task-graph cascade. Fires when a task transitions to a settled
// state — `done` (subordinate closed it) or `review` (subordinate
// emitted [[OCCA:REVIEW]] and is asking for human eyes). Both states
// need to bubble up:
//   1. unblockDependents — any task with this in its blocked_by_task_ids
//      gets the entry removed; if their list goes empty AND they were
//      parked in `blocked`, flip back to `todo` + dispatch. (Done-only —
//      a review task isn't unblocking anything.)
//   2. cascadeOnTaskDone — if this task has a parent AND all siblings
//      are also settled, wake the parent so its agent can synthesize.
//      For chat-origin top-level tasks, invokes the synthesis service
//      which posts a CEO-framed reply back to the user's chat thread
//      ("here's what shipped" for done, "Jhon wants review" for review).
//
// Name kept as `cascadeOnTaskDone` for backwards compat with imports;
// semantically it's `cascadeOnTaskSettled` now.
//
// Mirror of the autonomy doc §3.1 `task.children_completed` event.

import { childLogger } from "../../../lib/logger";
import { enqueueTaskDispatch } from "../../../infra/queue/task-worker";
import { synthesizeForTask } from "../../../services/delegation/synthesis";
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
  | "woken"
  | "ceo_synthesis_triggered";

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
  const task = await findTaskById(input.taskId);
  if (!task) {
    return { parentWoken: false, parentTaskId: null, reason: "no_parent" };
  }

  // Unblock dependents only when this task is truly closed. Review
  // status means "not yet final, awaiting human" — dependents that
  // were blocked on this task should keep waiting until the user
  // approves and the task transitions to done.
  if (task.status === "done") {
    void unblockDependents(input.taskId).catch((err) => {
      log.error({ err, taskId: input.taskId }, "unblockDependents failed");
    });
  }
  if (!task.parentTaskId) {
    // Top-level task with no parent. If it originated from a chat
    // thread (user_ceo or agent_dm in Phase C), kick the unified
    // synthesis dispatcher which loads the thread, picks the right
    // speaker, runs the synthesis turn, and recursively bubbles the
    // result up parent_thread_id until the user_ceo root is reached.
    if (task.originatingThreadId) {
      void synthesizeForTask({ taskId: task.id }).catch((err) => {
        log.error(
          { err, taskId: task.id },
          "synthesis bubble trigger failed",
        );
      });
      return {
        parentWoken: false,
        parentTaskId: null,
        reason: "ceo_synthesis_triggered",
      };
    }
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
