// L2 task-graph cascade. When a task transitions to `done`, check whether
// all sibling children of the same parent are also `done`. If yes, the
// parent task's agent is re-woken so they can synthesize the children's
// output (close out, request more work, hand off, etc.).
//
// Mirror of the autonomy doc §3.1 `task.children_completed` event:
//   on task.completed(taskId):
//     parent = getParent(taskId)
//     if parent and allChildrenDone(parent):
//       wakeAgent(parent.assigneeAgentId, reason=children_completed)
//
// Implementation: re-enqueue parent through the existing pg-boss dispatch
// queue. Parent must transition back to a dispatchable state — it was
// likely sitting in `review` (per the task-dispatcher's "waiting on
// approval" branch). We flip it to `todo` and clear `linkedTraceId` so
// the dispatcher picks it up cleanly.

import { and, eq, ne, sql } from "drizzle-orm";
import { tasks } from "@occa/shared/schema";
import { db } from "../infra/database/client";
import { childLogger } from "../lib/logger";

const log = childLogger("task-cascade");
import { enqueueTaskDispatch } from "../infra/queue/task-worker";

export interface CascadeOnTaskDoneInput {
  taskId: string;
}

export interface CascadeOnTaskDoneResult {
  parentWoken: boolean;
  parentTaskId: string | null;
  reason:
    | "no_parent"
    | "siblings_pending"
    | "parent_already_done"
    | "parent_unassigned"
    | "parent_not_found"
    | "woken";
}

// Side-effect kicked off in parallel with the parent-completion check.
// Tasks that listed `taskId` in their blockedByTaskIds get the entry
// removed; if their list goes empty AND they're sitting in `blocked`,
// flip them back to `todo` and re-dispatch.
//
// Uses a single SQL UPDATE with `array_remove` to do the prune
// transactionally — array_remove of a non-existent element is a no-op
// so it's safe to apply against rows we haven't pre-filtered.
async function unblockDependents(taskId: string): Promise<string[]> {
  // Pull task ids whose blocked_by_task_ids array contains us.
  const dependents = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      assignedDeploymentId: tasks.assignedDeploymentId,
    })
    .from(tasks)
    .where(sql`${taskId}::uuid = ANY(${tasks.blockedByTaskIds})`);

  if (dependents.length === 0) return [];

  const woken: string[] = [];
  for (const dep of dependents) {
    // Strip ourselves from their blocker list. If the list is now empty
    // and the task was parked in `blocked`, flip back to `todo` and
    // re-dispatch. Otherwise just record the prune and leave status
    // alone (other blockers still pending).
    const updated = await db
      .update(tasks)
      .set({
        blockedByTaskIds: sql`array_remove(${tasks.blockedByTaskIds}, ${taskId}::uuid)`,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, dep.id))
      .returning({
        id: tasks.id,
        blockedByTaskIds: tasks.blockedByTaskIds,
      });

    const after = updated[0];
    if (!after) continue;
    const blockersEmpty = after.blockedByTaskIds.length === 0;

    if (
      blockersEmpty &&
      dep.status === "blocked" &&
      dep.assignedDeploymentId !== null
    ) {
      await db
        .update(tasks)
        .set({
          status: "todo",
          linkedTraceId: null,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, dep.id));
      void enqueueTaskDispatch(dep.id).catch((err) => {
        log.error({ err, taskId: dep.id }, "unblock dispatch failed");
      });
      woken.push(dep.id);
      log.info(
        { taskId: dep.id, lastBlocker: taskId },
        "blockers resolved, dependent task woken",
      );
    }
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

  // 1. Pull the just-completed task to find its parent.
  const [task] = await db
    .select({
      id: tasks.id,
      parentTaskId: tasks.parentTaskId,
      companyId: tasks.companyId,
    })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1);

  if (!task?.parentTaskId) {
    return { parentWoken: false, parentTaskId: null, reason: "no_parent" };
  }

  // 2. Check that ALL siblings (children of this parent, including the
  //    just-completed one) are `done`. If any are still active (todo /
  //    in_progress / review), the parent shouldn't wake yet — there's
  //    more work in flight.
  const pendingSiblings = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(
      and(eq(tasks.parentTaskId, task.parentTaskId), ne(tasks.status, "done")),
    );

  if (pendingSiblings.length > 0) {
    return {
      parentWoken: false,
      parentTaskId: task.parentTaskId,
      reason: "siblings_pending",
    };
  }

  // 3. Load the parent. Skip if already closed or unassigned.
  const [parent] = await db
    .select({
      id: tasks.id,
      assignedDeploymentId: tasks.assignedDeploymentId,
      status: tasks.status,
    })
    .from(tasks)
    .where(eq(tasks.id, task.parentTaskId))
    .limit(1);

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

  // 4. Reset parent to a dispatchable state. The dispatcher's first-line
  //    guard refuses to launch on tasks already `in_progress` with a
  //    linked trace; flipping back to `todo` + clearing the trace ref
  //    bypasses that cleanly. The agent's previous trace stays in DB
  //    (history) — only the live linkage is cleared.
  await db
    .update(tasks)
    .set({
      status: "todo",
      linkedTraceId: null,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, parent.id));

  // 5. Enqueue dispatch through the same pg-boss queue used by every
  //    other task wake. Fire-and-forget — failure here is non-fatal,
  //    user can manually re-trigger from UI if it never lands.
  await enqueueTaskDispatch(parent.id);

  log.info(
    `[task-cascade] children_completed: parent=${parent.id} woken via task.dispatch queue (triggered by child=${input.taskId})`,
  );

  return {
    parentWoken: true,
    parentTaskId: parent.id,
    reason: "woken",
  };
}
