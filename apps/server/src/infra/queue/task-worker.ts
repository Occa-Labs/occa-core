import type { Job } from "pg-boss";
import { childLogger } from "../../lib/logger";
import { dispatchTask } from "../../services/task-dispatcher";
import { getBoss, TASK_DISPATCH_QUEUE, type TaskDispatchJobData } from "./boss";

const log = childLogger("task-worker");

export async function registerTaskWorker(): Promise<void> {
  const boss = await getBoss();

  await boss.work<TaskDispatchJobData>(
    TASK_DISPATCH_QUEUE,
    {
      // Number of worker pollers in this node; each picks up jobs independently.
      // A task can block for minutes waiting on the gateway reply, so we want
      // some parallelism here.
      localConcurrency: 3,
      pollingIntervalSeconds: 2,
    },
    async (jobs: Job<TaskDispatchJobData>[]) => {
      for (const job of jobs) {
        const { taskId } = job.data;
        log.info({ taskId, jobId: job.id }, "dispatching task");
        try {
          await dispatchTask(taskId);
          log.info({ taskId, jobId: job.id }, "task completed");
        } catch (err) {
          log.error({ err, taskId, jobId: job.id }, "task dispatch failed");
          throw err;
        }
      }
    },
  );

  log.info({ queue: TASK_DISPATCH_QUEUE }, "task worker listening");
}

export async function enqueueTaskDispatch(taskId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(
    TASK_DISPATCH_QUEUE,
    { taskId } satisfies TaskDispatchJobData,
    {
      // Dedup key — pg-boss won't queue a second job with the same key while
      // one is already active/queued. Belt-and-suspenders against double-click.
      singletonKey: taskId,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      // Agent reply timeout is 10 min; give the job slot 15 before pg-boss
      // considers it stalled and retries.
      expireInSeconds: 15 * 60,
    },
  );
}
