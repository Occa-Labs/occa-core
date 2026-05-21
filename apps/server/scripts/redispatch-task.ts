#!/usr/bin/env tsx
// Manually enqueue one `task.dispatch` job for a task — an ops escape
// hatch for a task left in `todo` with no live job (e.g. its dispatch
// died to a server restart and pg-boss retries were exhausted).
//
// The server must be running — its task-worker picks the job up. This
// script only SENDs to the queue, then exits.
//
// Usage (from apps/server/):
//
//   pnpm exec tsx --env-file=../../.env scripts/redispatch-task.ts <taskId>

import { eq } from "drizzle-orm";
import { tasks } from "@occa/shared/schema";
import { db, pool } from "../src/infra/database/client";
import { enqueueTaskDispatch } from "../src/infra/queue/task-worker";
import { stopBoss } from "../src/infra/queue/boss";

async function main(): Promise<void> {
  const taskId = process.argv[2];
  if (!taskId) {
    console.error("usage: redispatch-task.ts <taskId>");
    process.exit(1);
  }

  const [task] = await db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (!task) {
    console.error(`task ${taskId} not found`);
    process.exit(1);
  }
  console.log(`task ${task.id} "${task.title}" — status=${task.status}`);

  await enqueueTaskDispatch(taskId);
  console.log("task.dispatch job enqueued — the running server will pick it up.");
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
