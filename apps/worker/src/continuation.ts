import { eq } from "drizzle-orm";
import { tasks } from "@occa/shared/schema";
import type { LivenessState, TaskStatus } from "@occa/shared/types";
import { isTransientError } from "@occa/shared/errors";
import { db } from "./db";
import { wakeup } from "./wakeup";
import { MAX_RETRY_ATTEMPTS, nextRetryDelayMs } from "./retry-policy";

const CONTINUATION_TERMINAL: TaskStatus[] = ["done", "review"];

async function loadTaskOwnership(
  taskId: string,
): Promise<{ status: TaskStatus; assignedAgentId: string | null } | null> {
  const [row] = await db
    .select({
      status: tasks.status,
      assignedAgentId: tasks.assignedAgentId,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!row) return null;
  return {
    status: row.status as TaskStatus,
    assignedAgentId: row.assignedAgentId,
  };
}

const MAX_CONTINUATION = 2;

export interface RetryDecision {
  enqueued: boolean;
  exhausted: boolean;
  reason: string;
  traceId?: string;
  scheduledAt?: Date;
}

export async function decideRetryOnFailure(args: {
  traceId: string;
  taskId: string | null;
  agentId: string;
  errorCode: string | null;
  failureRetryAttempt: number;
}): Promise<RetryDecision> {
  if (!isTransientError(args.errorCode)) {
    return { enqueued: false, exhausted: true, reason: "non_transient_error" };
  }
  const nextAttempt = args.failureRetryAttempt + 1;
  if (nextAttempt > MAX_RETRY_ATTEMPTS) {
    return { enqueued: false, exhausted: true, reason: "max_retries_reached" };
  }
  const delayMs = nextRetryDelayMs(args.failureRetryAttempt);
  if (delayMs === null) {
    return { enqueued: false, exhausted: true, reason: "no_delay_configured" };
  }
  const scheduledAt = new Date(Date.now() + delayMs);
  const idempotencyKey = `retry:${args.traceId}:${nextAttempt}`;

  const result = await wakeup({
    agentId: args.agentId,
    source: "automation",
    triggerDetail: "retry",
    reason: `retry attempt ${nextAttempt} after ${args.errorCode ?? "unknown_error"}`,
    taskId: args.taskId,
    failureRetryAttempt: nextAttempt,
    retryOfTraceId: args.traceId,
    retryReason: args.errorCode ?? undefined,
    idempotencyKey,
    actor: { type: "system", id: null },
    scheduledAt,
  });

  return {
    enqueued: !result.coalesced,
    exhausted: false,
    reason: result.coalesced ? "coalesced_into_existing_trace" : "enqueued",
    traceId: result.traceId,
    scheduledAt,
  };
}

export interface ContinuationDecision {
  enqueued: boolean;
  exhausted: boolean;
  reason: string;
  traceId?: string;
}

export async function decideTraceContinuation(args: {
  traceId: string;
  taskId: string;
  agentId: string;
  livenessState: LivenessState;
  continuationAttempt: number;
}): Promise<ContinuationDecision> {
  if (args.livenessState === "normal") {
    return { enqueued: false, exhausted: false, reason: "not_needed" };
  }
  const nextAttempt = args.continuationAttempt + 1;
  if (nextAttempt > MAX_CONTINUATION) {
    return { enqueued: false, exhausted: true, reason: "max_attempts_reached" };
  }

  const ownership = await loadTaskOwnership(args.taskId);
  if (!ownership) {
    return { enqueued: false, exhausted: true, reason: "task_missing" };
  }
  if (CONTINUATION_TERMINAL.includes(ownership.status)) {
    return { enqueued: false, exhausted: true, reason: "task_closed" };
  }
  if (ownership.assignedAgentId !== args.agentId) {
    return { enqueued: false, exhausted: true, reason: "task_not_assigned" };
  }

  const idempotencyKey = `continuation:${args.taskId}:${args.traceId}:${args.livenessState}:${nextAttempt}`;

  const result = await wakeup({
    agentId: args.agentId,
    source: "automation",
    triggerDetail: "continuation",
    reason: `continuation attempt ${nextAttempt} after ${args.livenessState}`,
    taskId: args.taskId,
    continuationAttempt: nextAttempt,
    retryOfTraceId: args.traceId,
    idempotencyKey,
    actor: { type: "system", id: null },
  });

  return {
    enqueued: !result.coalesced,
    exhausted: false,
    reason: result.coalesced ? "coalesced_into_existing_trace" : "enqueued",
    traceId: result.traceId,
  };
}
