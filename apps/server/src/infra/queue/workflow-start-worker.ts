// pg-boss handler for the workflow.start queue. One job per routine
// fire that names a sequential workflow; the handler creates the run
// row and spawns step 0 via the engine. Separate from workflow.evaluate
// (which advances an in-flight run on a done-transition) because the
// start trigger is the wrapper task's creation, not a completion.

import type { Job } from "pg-boss";
import { childLogger } from "../../lib/logger";
import { startWorkflowRun } from "../../features/workflows/services/engine";
import {
  getBoss,
  WORKFLOW_START_QUEUE,
  type WorkflowStartJobData,
} from "./boss";

const log = childLogger("workflow-start-worker");

export async function registerWorkflowStartWorker(): Promise<void> {
  const boss = await getBoss();

  await boss.work<WorkflowStartJobData>(
    WORKFLOW_START_QUEUE,
    {
      localConcurrency: 2,
      pollingIntervalSeconds: 2,
    },
    async (jobs: Job<WorkflowStartJobData>[]) => {
      for (const job of jobs) {
        const { parentTaskId, workflowYamlId } = job.data;
        log.info(
          { parentTaskId, workflowYamlId, jobId: job.id },
          "starting workflow run",
        );
        try {
          await startWorkflowRun(job.data);
        } catch (err) {
          log.error(
            { err, parentTaskId, workflowYamlId, jobId: job.id },
            "workflow start failed",
          );
          throw err; // pg-boss handles retry semantics
        }
      }
    },
  );

  log.info({ queue: WORKFLOW_START_QUEUE }, "workflow start worker listening");
}
