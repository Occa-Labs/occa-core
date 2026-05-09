// pg-boss handler for the workflow.evaluate queue. One job per parent
// task that just transitioned to done; the handler delegates to the
// engine which loads matching workflows, spawns children, and emits a
// WorkflowExecuted audit row.

import type { Job } from "pg-boss";
import { childLogger } from "../../lib/logger";
import { runWorkflowsForTask } from "../../features/workflows/services/engine";
import {
  getBoss,
  WORKFLOW_EVALUATE_QUEUE,
  type WorkflowEvaluateJobData,
} from "./boss";

const log = childLogger("workflow-worker");

export async function registerWorkflowWorker(): Promise<void> {
  const boss = await getBoss();

  await boss.work<WorkflowEvaluateJobData>(
    WORKFLOW_EVALUATE_QUEUE,
    {
      // Evaluations are I/O-bound (a few inserts per workflow run). Two
      // pollers is plenty for foundation; bump if the queue ever backs
      // up.
      localConcurrency: 2,
      pollingIntervalSeconds: 2,
    },
    async (jobs: Job<WorkflowEvaluateJobData>[]) => {
      for (const job of jobs) {
        const { taskId } = job.data;
        log.info({ taskId, jobId: job.id }, "evaluating workflows for task");
        try {
          const result = await runWorkflowsForTask(taskId);
          log.info(
            {
              taskId,
              jobId: job.id,
              evaluated: result.evaluated,
              spawned: result.spawnedTotal,
              skipped: result.skippedAlreadyEvaluated,
            },
            "workflow evaluation finished",
          );
        } catch (err) {
          log.error(
            { err, taskId, jobId: job.id },
            "workflow evaluation failed",
          );
          throw err; // pg-boss handles retry semantics
        }
      }
    },
  );

  log.info({ queue: WORKFLOW_EVALUATE_QUEUE }, "workflow worker listening");
}

export async function enqueueWorkflowEvaluation(taskId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(
    WORKFLOW_EVALUATE_QUEUE,
    { taskId } satisfies WorkflowEvaluateJobData,
    {
      // singletonKey=taskId pairs with the queue's `exclusive` policy:
      // a second `done` transition of the same task while an evaluation
      // is still queued/running is dropped silently. Combined with the
      // alreadyEvaluated() check inside the engine (which compares
      // against existing WorkflowExecuted audit rows) this gives us
      // double-layer dedup.
      singletonKey: taskId,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      // 5-minute job timeout headroom in case workflows fan out across
      // many rules.
      expireInSeconds: 5 * 60,
    },
  );
}
