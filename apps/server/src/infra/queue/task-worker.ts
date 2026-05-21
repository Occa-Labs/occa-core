import type { Job } from "pg-boss";
import { childLogger } from "../../lib/logger";
import { dispatchTask } from "../../features/tasks/services/dispatcher";
import { canDeploy } from "../../features/agents/services/deployment-hierarchy";
import { findCeoForCompany } from "../../features/agents/repositories/deployments";
import { insertMessage } from "../../features/chat/repositories/chat-messages";
import { resolveUserCeoThreadId } from "../../features/chat/repositories/chat-threads";
import { getBoss, TASK_DISPATCH_QUEUE, type TaskDispatchJobData } from "./boss";

const log = childLogger("task-worker");

// Composition root for the task dispatch flow. Threads cross-feature
// ports (`canDeploy` from features/agents, `postCeoChatMessage` which
// composes findCeoForCompany + insertMessage) into the dispatcher's
// action-block handlers so the dispatcher itself stays free of cross-
// feature imports. (Subordinate listing for prompt building is owned
// by the Context Pipeline, not injected here.)
//
// REPORT always lands on the CEO's chat thread — the user's chat
// surface — even when the root task was routed directly to a specialist
// via `assignToRole`. The emitter's deployment is NOT the deployment we
// write the chat message under; we resolve the CEO here per company.
const dispatchDeps = {
  canDeploy,
  postCeoChatMessage: async (args: {
    companyId: string;
    content: string;
    traceId: string;
  }): Promise<{ ok: true } | { ok: false; reason: "no_ceo_deployment" }> => {
    const ceo = await findCeoForCompany(args.companyId);
    if (!ceo) {
      log.warn(
        { companyId: args.companyId, traceId: args.traceId },
        "REPORT cannot post: company has no active CEO deployment",
      );
      return { ok: false, reason: "no_ceo_deployment" };
    }
    const threadId = await resolveUserCeoThreadId({
      companyId: args.companyId,
      ceoDeploymentId: ceo.id,
    });
    await insertMessage({
      threadId,
      companyId: args.companyId,
      deploymentId: ceo.id,
      role: "assistant",
      content: args.content,
      traceId: args.traceId,
    });
    return { ok: true };
  },
};

export async function registerTaskWorker(): Promise<void> {
  const boss = await getBoss();

  await boss.work<TaskDispatchJobData>(
    TASK_DISPATCH_QUEUE,
    {
      // Number of worker pollers in this node; each picks up jobs
      // independently. A task can block for minutes waiting on the
      // gateway reply, so we want some parallelism here.
      localConcurrency: 3,
      pollingIntervalSeconds: 2,
    },
    async (jobs: Job<TaskDispatchJobData>[]) => {
      for (const job of jobs) {
        const { taskId } = job.data;
        log.info({ taskId, jobId: job.id }, "dispatching task");
        try {
          await dispatchTask(taskId, dispatchDeps);
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

export async function enqueueTaskDispatch(
  taskId: string,
  opts?: { dedupe?: boolean },
): Promise<void> {
  const boss = await getBoss();
  await boss.send(
    TASK_DISPATCH_QUEUE,
    { taskId } satisfies TaskDispatchJobData,
    {
      // Dedup key — pg-boss won't queue a second job with the same key while
      // one is already active/queued. Belt-and-suspenders against double-click.
      //
      // A re-dispatch (`dedupe: false` — a verification or review bounce)
      // is enqueued while a `task.dispatch` job for the same task may
      // still be active, so it cannot reuse the `taskId` key. It must NOT
      // fall back to a null key either: on the `exclusive` queue a null
      // singletonKey is one slot shared across ALL tasks, so two
      // concurrent bounces of different tasks would collide and one would
      // be silently dropped. A unique per-send key avoids both.
      singletonKey:
        opts?.dedupe === false ? `${taskId}:${Date.now()}` : taskId,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      // Agent reply timeout is 10 min; give the job slot 15 before pg-boss
      // considers it stalled and retries.
      expireInSeconds: 15 * 60,
    },
  );
}
