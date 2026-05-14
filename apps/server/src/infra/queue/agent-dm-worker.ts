import type { Job } from "pg-boss";
import { childLogger } from "../../lib/logger";
import { processAgentDmTurn } from "../../features/chat/services/agent-dm-handler";
import {
  getBoss,
  AGENT_DM_DISPATCH_QUEUE,
  type AgentDmDispatchJobData,
} from "./boss";

const log = childLogger("agent-dm-worker");

export async function registerAgentDmWorker(): Promise<void> {
  const boss = await getBoss();

  await boss.work<AgentDmDispatchJobData>(
    AGENT_DM_DISPATCH_QUEUE,
    {
      // DM thread turn = single adapter call (no nested workflow). Two
      // pollers is enough for now — Heads receive directives serially
      // (one user request → one fan-out at the CEO).
      localConcurrency: 2,
      pollingIntervalSeconds: 2,
    },
    async (jobs: Job<AgentDmDispatchJobData>[]) => {
      for (const job of jobs) {
        const { threadId } = job.data;
        log.info({ threadId, jobId: job.id }, "processing agent_dm thread");
        try {
          const result = await processAgentDmTurn(threadId);
          log.info(
            { threadId, jobId: job.id, result: result.kind },
            "agent_dm thread turn finished",
          );
        } catch (err) {
          log.error(
            { err, threadId, jobId: job.id },
            "agent_dm thread dispatch failed",
          );
          throw err;
        }
      }
    },
  );

  log.info({ queue: AGENT_DM_DISPATCH_QUEUE }, "agent_dm worker listening");
}

export async function enqueueAgentDmDispatch(threadId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(
    AGENT_DM_DISPATCH_QUEUE,
    { threadId } satisfies AgentDmDispatchJobData,
    {
      singletonKey: threadId,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 15 * 60,
    },
  );
}
