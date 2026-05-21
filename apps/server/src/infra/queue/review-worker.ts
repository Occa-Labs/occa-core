import type { Job } from "pg-boss";
import { childLogger } from "../../lib/logger";
import { dispatchHeadReview } from "../../features/tasks/services/head-review";
import {
  getBoss,
  REVIEW_DISPATCH_QUEUE,
  type ReviewDispatchJobData,
} from "./boss";

const log = childLogger("review-worker");

// Binds the `review.dispatch` queue to the auto-reviewer. A delegated
// task that lands in `review` is handed to the Head that delegated it;
// `dispatchHeadReview` runs the review turn and applies the verdict.
export async function registerReviewWorker(): Promise<void> {
  const boss = await getBoss();

  await boss.work<ReviewDispatchJobData>(
    REVIEW_DISPATCH_QUEUE,
    {
      // A review blocks on the gateway reply for minutes — keep a little
      // parallelism so concurrent reviews don't queue behind each other.
      localConcurrency: 2,
      pollingIntervalSeconds: 2,
    },
    async (jobs: Job<ReviewDispatchJobData>[]) => {
      for (const job of jobs) {
        const { taskId } = job.data;
        log.info({ taskId, jobId: job.id }, "dispatching head review");
        try {
          await dispatchHeadReview(taskId);
          log.info({ taskId, jobId: job.id }, "head review completed");
        } catch (err) {
          log.error({ err, taskId, jobId: job.id }, "head review failed");
          throw err;
        }
      }
    },
  );

  log.info({ queue: REVIEW_DISPATCH_QUEUE }, "review worker listening");
}

// Enqueue a delegated `review`-status task for the auto-reviewer.
// `singletonKey` = taskId: while a review for this task is queued or
// active, a second enqueue is dropped (one Head review per landing).
export async function enqueueReviewDispatch(taskId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(
    REVIEW_DISPATCH_QUEUE,
    { taskId } satisfies ReviewDispatchJobData,
    {
      singletonKey: taskId,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 15 * 60,
    },
  );
}
