#!/usr/bin/env tsx
// Manually enqueue a `review.dispatch` job for one task — a test harness
// for the auto-reviewer. The normal trigger lives in the task dispatcher
// and only fires for tasks that land in `review` AFTER the auto-reviewer
// shipped; a task already parked in `review` (e.g. a pre-existing test
// fixture) never auto-triggers, so this script kicks it by hand.
//
// The server must be running — its review-worker is what picks the job
// up. This script only SENDs to the queue, then exits.
//
// Usage (from apps/server/):
//
//   pnpm exec tsx --env-file=../../.env scripts/trigger-head-review.ts <taskId>

import { eq } from "drizzle-orm";
import { tasks } from "@occa/shared/schema";
import { db, pool } from "../src/infra/database/client";
import { enqueueReviewDispatch } from "../src/infra/queue/review-worker";
import { stopBoss } from "../src/infra/queue/boss";

async function main(): Promise<void> {
  const taskId = process.argv[2];
  if (!taskId) {
    console.error("usage: trigger-head-review.ts <taskId>");
    process.exit(1);
  }

  const [task] = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      createdBy: tasks.createdByDeploymentId,
      assignee: tasks.assignedDeploymentId,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (!task) {
    console.error(`task ${taskId} not found`);
    process.exit(1);
  }
  console.log(
    `task ${task.id} "${task.title}" — status=${task.status} ` +
      `createdBy=${task.createdBy} assignee=${task.assignee}`,
  );
  if (task.status !== "review") {
    console.warn(
      `warning: task is not in 'review' (it is '${task.status}'); ` +
        "dispatchHeadReview will skip it.",
    );
  }

  await enqueueReviewDispatch(taskId);
  console.log("review.dispatch job enqueued — the running server will pick it up.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopBoss().catch(() => {});
    await pool.end().catch(() => {});
  });
