import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  agentIdentities,
  agentRuntimeProfile,
  companySkills,
  deploymentApiKeys,
  deploymentRuntimeState,
  deploymentTaskSessions,
  deployments,
  episodicMemory,
  tasks,
  traceEvents,
  traces,
} from "@occa/shared/schema";
import type {
  AdapterExecutionContext,
  AdapterTraceEvent,
  AssignedSkill,
  LivenessState,
  WakePayload,
} from "@occa/runtime-core";
import type { TraceStatus, TraceUsage } from "@occa/shared/types";
import { db } from "./db";
import { getAdapter } from "./adapter-registry";
import { decideRetryOnFailure, decideTraceContinuation } from "./continuation";
import {
  syncTaskOnTraceFailed,
  syncTaskOnTraceStart,
  syncTaskOnTraceSucceeded,
} from "./task-sync";
import { executeRoutineDelegations } from "./delegation";

const TICK_INTERVAL_MS = 2_000;
const DEFAULT_CONCURRENCY = 4;

interface ClaimedTrace {
  id: string;
  companyId: string;
  agentId: string;
  taskId: string | null;
  retryOfTraceId: string | null;
  invocationSource: string;
  triggerDetail: string | null;
  wakePayload: Record<string, unknown> | null;
  continuationAttempt: number;
  failureRetryAttempt: number;
}

async function claimTraces(limit: number): Promise<ClaimedTrace[]> {
  // One transaction: SELECT ... FOR UPDATE SKIP LOCKED, then transition to
  // "running". Using raw SQL (drizzle's .for() must be inside a transaction
  // that also issues the UPDATE for the rows to remain locked).
  const claimed = await db.transaction(async (tx) => {
    const { rows } = await tx.execute<{
      id: string;
      company_id: string;
      deployment_id: string;
      task_id: string | null;
      retry_of_trace_id: string | null;
      invocation_source: string;
      trigger_detail: string | null;
      wake_payload: Record<string, unknown> | null;
      continuation_attempt: number;
      failure_retry_attempt: number;
    }>(sql`
      SELECT id, company_id, deployment_id, task_id, retry_of_trace_id,
             invocation_source, trigger_detail, wake_payload,
             continuation_attempt, failure_retry_attempt
      FROM traces
      WHERE status = 'queued'
        AND (scheduled_at IS NULL OR scheduled_at <= now())
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);
    if (rows.length === 0) return [] as ClaimedTrace[];
    const ids = rows.map((r) => r.id);
    await tx
      .update(traces)
      .set({
        status: "running",
        startedAt: new Date(),
        processPid: process.pid,
        processStartedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(traces.id, ids));
    return rows.map(
      (r): ClaimedTrace => ({
        id: r.id,
        companyId: r.company_id,
        agentId: r.deployment_id,
        taskId: r.task_id,
        retryOfTraceId: r.retry_of_trace_id,
        invocationSource: r.invocation_source,
        triggerDetail: r.trigger_detail,
        wakePayload: r.wake_payload,
        continuationAttempt: r.continuation_attempt,
        failureRetryAttempt: r.failure_retry_attempt ?? 0,
      }),
    );
  });
  return claimed;
}

// Mint an ephemeral API key for the duration of the trace. Simpler than
// retrieving existing keys (they're hashed). Stored like any other key
// so the agent's calls can be verified server-side.
async function mintEphemeralAgentKey(
  deploymentId: string,
  companyId: string,
  traceId: string,
): Promise<string> {
  const raw = `occa_ag_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  await db.insert(deploymentApiKeys).values({
    deploymentId,
    companyId,
    name: `trace:${traceId}`,
    keyHash: hash,
  });
  return raw;
}

// Denormalized agent context built per-trace via JOIN: deployment +
// identity name + runtime profile (adapter wiring + desired skills).
interface LoadedAgent {
  id: string;
  companyId: string;
  name: string;
  role: string;
  deploymentIndex: number;
  adapterType: string;
  adapterConfig: unknown;
  externalAgentId: string | null;
  desiredSkills: string[];
}

async function loadAgent(deploymentId: string): Promise<LoadedAgent | null> {
  const [row] = await db
    .select({
      id: deployments.id,
      companyId: deployments.companyId,
      role: deployments.role,
      deploymentIndex: deployments.deploymentIndex,
      name: agentIdentities.name,
      adapterType: agentRuntimeProfile.adapterType,
      adapterConfig: agentRuntimeProfile.adapterConfig,
      externalAgentId: agentRuntimeProfile.externalAgentId,
      desiredSkills: agentRuntimeProfile.desiredSkills,
    })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .innerJoin(
      agentRuntimeProfile,
      eq(agentRuntimeProfile.deploymentId, deployments.id),
    )
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  return row ?? null;
}

// Direct reports of a deployment — the routine-wake delegation roster.
// `parent_deployment_index` points at the parent's `deployment_index`.
const COVERAGE_LOOKBACK_DAYS = 14;
const COVERAGE_LIMIT = 12;

// Recent episodes of the company's own coverage, newest first. Surfaced
// in a routine wake so an orchestrator can vary the next slate rather
// than repeat a topic.
async function loadRecentCoverage(
  companyId: string,
): Promise<{ date: string; category: string; title: string }[]> {
  const since = new Date(
    Date.now() - COVERAGE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  const rows = await db
    .select({
      occurredAt: episodicMemory.occurredAt,
      category: episodicMemory.category,
      title: episodicMemory.title,
    })
    .from(episodicMemory)
    .where(
      and(
        eq(episodicMemory.companyId, companyId),
        gte(episodicMemory.occurredAt, since),
      ),
    )
    .orderBy(desc(episodicMemory.occurredAt))
    .limit(COVERAGE_LIMIT);
  return rows.map((r) => ({
    date: r.occurredAt.toISOString().slice(0, 10),
    category: r.category,
    title: r.title,
  }));
}

async function loadSubordinates(
  companyId: string,
  parentDeploymentIndex: number,
): Promise<{ id: string; name: string; role: string }[]> {
  return db
    .select({
      id: deployments.id,
      name: agentIdentities.name,
      role: deployments.role,
    })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(
      and(
        eq(deployments.companyId, companyId),
        eq(deployments.parentDeploymentIndex, parentDeploymentIndex),
      ),
    );
}

async function loadAssignedSkills(
  companyId: string,
  desiredSkills: string[],
): Promise<AssignedSkill[]> {
  if (desiredSkills.length === 0) return [];
  const rows = await db
    .select({
      key: companySkills.key,
      slug: companySkills.slug,
      name: companySkills.name,
      description: companySkills.description,
      markdown: companySkills.markdown,
    })
    .from(companySkills)
    .where(
      and(
        eq(companySkills.companyId, companyId),
        inArray(companySkills.key, desiredSkills),
      ),
    );
  // Preserve the order of desiredSkills so inline preambles stay stable.
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return desiredSkills
    .map((k) => byKey.get(k))
    .filter((r): r is NonNullable<typeof r> => r != null)
    .map((r) => ({
      key: r.key,
      slug: r.slug,
      name: r.name,
      description: r.description,
      markdown: r.markdown,
    }));
}

async function loadTaskForWake(taskId: string | null) {
  if (!taskId) return null;
  const [row] = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      blocks: tasks.blocks,
      status: tasks.status,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  return row ?? null;
}

async function loadOrCreateSession(input: {
  companyId: string;
  agentId: string;
  adapterType: string;
  taskKey: string;
}) {
  const [row] = await db
    .select()
    .from(deploymentTaskSessions)
    .where(
      and(
        eq(deploymentTaskSessions.companyId, input.companyId),
        eq(deploymentTaskSessions.deploymentId, input.agentId),
        eq(deploymentTaskSessions.adapterType, input.adapterType),
        eq(deploymentTaskSessions.taskKey, input.taskKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function upsertSession(input: {
  companyId: string;
  agentId: string;
  adapterType: string;
  taskKey: string;
  sessionParamsJson: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  lastTraceId: string;
  lastError: string | null;
}) {
  await db
    .insert(deploymentTaskSessions)
    .values({
      companyId: input.companyId,
      deploymentId: input.agentId,
      adapterType: input.adapterType,
      taskKey: input.taskKey,
      sessionParamsJson: input.sessionParamsJson,
      sessionDisplayId: input.sessionDisplayId,
      lastTraceId: input.lastTraceId,
      lastError: input.lastError,
    })
    .onConflictDoUpdate({
      target: [
        deploymentTaskSessions.companyId,
        deploymentTaskSessions.deploymentId,
        deploymentTaskSessions.adapterType,
        deploymentTaskSessions.taskKey,
      ],
      set: {
        sessionParamsJson: input.sessionParamsJson,
        sessionDisplayId: input.sessionDisplayId,
        lastTraceId: input.lastTraceId,
        lastError: input.lastError,
        updatedAt: new Date(),
      },
    });
}

async function recordEvent(args: {
  companyId: string;
  traceId: string;
  agentId: string;
  seq: number;
  event: AdapterTraceEvent;
}) {
  await db.insert(traceEvents).values({
    companyId: args.companyId,
    traceId: args.traceId,
    deploymentId: args.agentId,
    seq: args.seq,
    eventType: args.event.type,
    stream: args.event.stream ?? null,
    level: args.event.level ?? null,
    message: args.event.message ?? null,
    payload: args.event.payload ?? null,
  });
}

async function finalizeTrace(args: {
  traceId: string;
  status: TraceStatus;
  error: { code: string; message: string } | null;
  livenessState: LivenessState | null;
  usage: TraceUsage | null;
  resultJson: Record<string, unknown> | null;
  sessionIdAfter: string | null;
}) {
  await db
    .update(traces)
    .set({
      status: args.status,
      finishedAt: new Date(),
      updatedAt: new Date(),
      error: args.error?.message ?? null,
      errorCode: args.error?.code ?? null,
      livenessState: args.livenessState,
      usageJson: args.usage ?? null,
      resultJson: args.resultJson,
      sessionIdAfter: args.sessionIdAfter,
    })
    .where(eq(traces.id, args.traceId));
}

async function updateRuntimeCounters(args: {
  agentId: string;
  companyId: string;
  traceId: string;
  lastTraceStatus: TraceStatus;
  lastError: string | null;
  usage: TraceUsage | null;
  sessionIdAfter: string | null;
}) {
  const usage = args.usage ?? {
    tokensIn: 0,
    tokensOut: 0,
    cachedTokensIn: 0,
    costCents: 0,
  };
  await db
    .insert(deploymentRuntimeState)
    .values({
      deploymentId: args.agentId,
      companyId: args.companyId,
      sessionId: args.sessionIdAfter,
      totalInputTokens: usage.tokensIn,
      totalOutputTokens: usage.tokensOut,
      totalCachedInputTokens: usage.cachedTokensIn,
      totalCostCents: usage.costCents,
      lastTraceId: args.traceId,
      lastTraceStatus: args.lastTraceStatus,
      lastError: args.lastError,
    })
    .onConflictDoUpdate({
      target: deploymentRuntimeState.deploymentId,
      set: {
        sessionId: args.sessionIdAfter,
        totalInputTokens: sql`${deploymentRuntimeState.totalInputTokens} + ${usage.tokensIn}`,
        totalOutputTokens: sql`${deploymentRuntimeState.totalOutputTokens} + ${usage.tokensOut}`,
        totalCachedInputTokens: sql`${deploymentRuntimeState.totalCachedInputTokens} + ${usage.cachedTokensIn}`,
        totalCostCents: sql`${deploymentRuntimeState.totalCostCents} + ${usage.costCents}`,
        lastTraceId: args.traceId,
        lastTraceStatus: args.lastTraceStatus,
        lastError: args.lastError,
        updatedAt: new Date(),
      },
    });
}

function buildWakePayload(
  trace: ClaimedTrace,
  taskId: string | null,
): WakePayload {
  return {
    traceId: trace.id,
    agentId: trace.agentId,
    companyId: trace.companyId,
    taskId,
    issueId: taskId,
    wakeReason: trace.triggerDetail,
    wakeCommentId: null,
    approvalId: null,
    approvalStatus: null,
    issueIds: taskId ? [taskId] : [],
    source: trace.invocationSource as WakePayload["source"],
    continuationAttempt: trace.continuationAttempt,
  };
}

async function executeClaim(trace: ClaimedTrace): Promise<void> {
  const agent = await loadAgent(trace.agentId);
  if (!agent) {
    await finalizeTrace({
      traceId: trace.id,
      status: "failed",
      error: { code: "agent_not_found", message: "agent missing" },
      livenessState: null,
      usage: null,
      resultJson: null,
      sessionIdAfter: null,
    });
    return;
  }
  const adapter = getAdapter(agent.adapterType);
  if (!adapter) {
    await finalizeTrace({
      traceId: trace.id,
      status: "failed",
      error: {
        code: "adapter_unknown",
        message: `no adapter registered for type ${agent.adapterType}`,
      },
      livenessState: null,
      usage: null,
      resultJson: null,
      sessionIdAfter: null,
    });
    return;
  }

  // task_id, failure_retry_attempt, and continuation_attempt are now stamped
  // directly on the trace row at creation time — no wakeup payload lookup needed.
  const taskId = trace.taskId;
  const inheritedRetryAttempt = trace.failureRetryAttempt;
  const task = await loadTaskForWake(taskId);
  const taskKey = `task:${taskId ?? trace.id}`;

  // Move the kanban card out of "todo" as soon as a trace actually starts
  // against it — the user's hint that work is underway.
  await syncTaskOnTraceStart(taskId, {
    traceId: trace.id,
    deploymentId: trace.agentId,
  }).catch((err) => {
    console.error(
      "[worker:dispatcher] task-sync on-start failed:",
      err instanceof Error ? err.message : err,
    );
  });

  const existingSession = await loadOrCreateSession({
    companyId: trace.companyId,
    agentId: trace.agentId,
    adapterType: agent.adapterType,
    taskKey,
  });

  const apiKey = await mintEphemeralAgentKey(
    trace.agentId,
    trace.companyId,
    trace.id,
  );
  const apiUrl = process.env.OCCA_SERVER_URL || "http://localhost:3002";

  const skills = await loadAssignedSkills(trace.companyId, agent.desiredSkills);

  const abortController = new AbortController();
  let seq = 0;
  const payload = buildWakePayload(trace, taskId);
  let livenessHint: LivenessState | null = null;

  // Routine wakes carry the standing mandate on the trace's wakePayload;
  // surface it to the adapter so it reaches the agent's wake text.
  const wp = trace.wakePayload ?? {};
  const routineTitle =
    typeof wp.routineTitle === "string" ? wp.routineTitle : undefined;
  const routineMandate =
    typeof wp.routineMandate === "string" ? wp.routineMandate : undefined;
  // A routine-woken orchestrator gets its team roster inline so it has
  // valid `targetAgentId` values for `[[OCCA:DELEGATE]]`.
  const subordinates = routineTitle
    ? await loadSubordinates(trace.companyId, agent.deploymentIndex)
    : [];
  // Recent coverage — lets a routine-woken orchestrator vary the slate.
  const recentCoverage = routineTitle
    ? await loadRecentCoverage(trace.companyId)
    : [];

  const baseSessionParams = existingSession?.sessionParamsJson
    ? ({
        ...(existingSession.sessionParamsJson as Record<string, unknown>),
        agentName: agent.name,
        agentRole: agent.role,
        taskTitle: task?.title,
        routineTitle,
        routineMandate,
        subordinates,
        recentCoverage,
      } as Record<string, unknown>)
    : ({
        agentName: agent.name,
        agentRole: agent.role,
        taskTitle: task?.title,
        routineTitle,
        routineMandate,
        subordinates,
        recentCoverage,
        sessionKey: taskKey,
      } as Record<string, unknown>);

  const ctx: AdapterExecutionContext = {
    payload,
    adapterConfig: (agent.adapterConfig as Record<string, unknown>) ?? {},
    runtimeEnv: {
      apiUrl,
      apiKey,
      agentId: agent.externalAgentId ?? agent.id,
      traceId: trace.id,
    },
    signal: abortController.signal,
    onEvent: (evt) => {
      seq += 1;
      void recordEvent({
        companyId: trace.companyId,
        traceId: trace.id,
        agentId: trace.agentId,
        seq,
        event: evt,
      }).catch((err) => {
        console.error(
          "[worker:dispatcher] event insert failed:",
          err instanceof Error ? err.message : err,
        );
      });
    },
    onLivenessHint: (state) => {
      livenessHint = state;
    },
    sessionParams: baseSessionParams,
    skills,
  };

  let status: TraceStatus = "succeeded";
  let error: { code: string; message: string } | null = null;
  let liveness: LivenessState | null = null;
  let usage: TraceUsage | null = null;
  let resultJson: Record<string, unknown> | null = null;
  let sessionIdAfter: string | null = null;

  try {
    const result = await adapter.executeTrace(ctx);
    status =
      result.outcome === "succeeded"
        ? "succeeded"
        : result.outcome === "cancelled"
          ? "cancelled"
          : result.outcome === "timed_out"
            ? "timed_out"
            : "failed";
    error = result.error;
    liveness = result.livenessState ?? livenessHint;
    usage = result.usage;
    resultJson = result.resultJson;
    sessionIdAfter = result.sessionIdAfter;
  } catch (err) {
    status = "failed";
    error = {
      code: "dispatcher_error",
      message: err instanceof Error ? err.message : String(err),
    };
    liveness = livenessHint;
  }

  await finalizeTrace({
    traceId: trace.id,
    status,
    error,
    livenessState: liveness,
    usage,
    resultJson,
    sessionIdAfter,
  });

  await upsertSession({
    companyId: trace.companyId,
    agentId: trace.agentId,
    adapterType: agent.adapterType,
    taskKey,
    sessionParamsJson: sessionIdAfter
      ? { sessionKey: taskKey, sessionId: sessionIdAfter }
      : ((existingSession?.sessionParamsJson as Record<
          string,
          unknown
        > | null) ?? null),
    sessionDisplayId: sessionIdAfter,
    lastTraceId: trace.id,
    lastError: error?.message ?? null,
  });

  await updateRuntimeCounters({
    agentId: trace.agentId,
    companyId: trace.companyId,
    traceId: trace.id,
    lastTraceStatus: status,
    lastError: error?.message ?? null,
    usage,
    sessionIdAfter,
  });

  // Advance the kanban card once we know the trace's outcome. Succeeded + real
  // reply → done (or review if the agent emitted [[OCCA:REVIEW]]). Liveness
  // hints like plan_only/empty_response leave the card at in_progress so the
  // continuation loop can keep nudging.
  if (status === "succeeded") {
    await syncTaskOnTraceSucceeded({
      taskId,
      traceId: trace.id,
      agentId: trace.agentId,
      livenessState: liveness,
      resultJson,
      finishedAt: new Date(),
    }).catch((err) => {
      console.error(
        "[worker:dispatcher] task-sync on-succeeded failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }

  // Routine-wake delegation: a routine carries no task, so the server's
  // task-bound DELEGATE handler never runs. Execute the orchestrator's
  // [[OCCA:DELEGATE]] blocks here so the work lands as real OCCA tasks.
  if (status === "succeeded" && routineTitle) {
    const reply =
      typeof resultJson?.text === "string" ? resultJson.text : "";
    if (reply.trim()) {
      await executeRoutineDelegations(reply, {
        companyId: trace.companyId,
        agentId: trace.agentId,
        parentTaskId: trace.taskId ?? null,
        subordinates,
      }).catch((err) => {
        console.error(
          "[worker:dispatcher] routine delegation failed:",
          err instanceof Error ? err.message : err,
        );
      });
    }
  }

  // Continuation: only on successful traces with a liveness hint that suggests
  // the agent didn't make progress.
  if (taskId && status === "succeeded" && liveness && liveness !== "normal") {
    try {
      await decideTraceContinuation({
        traceId: trace.id,
        taskId,
        agentId: trace.agentId,
        livenessState: liveness,
        continuationAttempt: trace.continuationAttempt,
      });
    } catch (err) {
      console.error(
        "[worker:dispatcher] continuation error:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Retry: failed traces with a transient error code get re-queued with
  // backoff, up to MAX_RETRY_ATTEMPTS. Permanent errors surface to
  // notifications.
  let retryEnqueued = false;
  if (status === "failed") {
    try {
      const decision = await decideRetryOnFailure({
        traceId: trace.id,
        taskId,
        agentId: trace.agentId,
        errorCode: error?.code ?? null,
        failureRetryAttempt: inheritedRetryAttempt,
      });
      retryEnqueued = decision.enqueued;
    } catch (err) {
      console.error(
        "[worker:dispatcher] retry decision error:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Terminal-failure task sync: when a trace ends in a non-success state
  // and no retry was queued, archive the linked task with a failure block.
  // Without this, the task stays at in_progress forever and the kanban
  // accumulates dead cards (routine wrappers piling up after Phase-A
  // timeouts were the trigger to add this path).
  if (
    taskId &&
    (status === "failed" || status === "timed_out" || status === "cancelled") &&
    !retryEnqueued
  ) {
    await syncTaskOnTraceFailed({
      taskId,
      traceId: trace.id,
      agentId: trace.agentId,
      outcome: status,
      errorCode: error?.code ?? null,
      errorMessage: error?.message ?? null,
      finishedAt: new Date(),
    }).catch((err) => {
      console.error(
        "[worker:dispatcher] task-sync on-failed failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }
}

let running = false;

async function tick(concurrency: number) {
  if (running) return;
  running = true;
  try {
    const claimed = await claimTraces(concurrency);
    if (claimed.length === 0) return;
    await Promise.all(
      claimed.map(async (trace) => {
        try {
          await executeClaim(trace);
        } catch (err) {
          console.error(
            `[worker:dispatcher] trace ${trace.id} crashed:`,
            err instanceof Error ? err.message : err,
          );
          await finalizeTrace({
            traceId: trace.id,
            status: "failed",
            error: {
              code: "dispatcher_crash",
              message: err instanceof Error ? err.message : String(err),
            },
            livenessState: null,
            usage: null,
            resultJson: null,
            sessionIdAfter: null,
          }).catch(() => {});
        }
      }),
    );
  } finally {
    running = false;
  }
}

export function startDispatcherLoop(): () => void {
  const concurrency =
    Number(process.env.WORKER_CONCURRENCY) || DEFAULT_CONCURRENCY;
  console.log(
    `[worker:dispatcher] started (tick=${TICK_INTERVAL_MS}ms concurrency=${concurrency})`,
  );
  const handle = setInterval(() => {
    void tick(concurrency).catch((err) => {
      console.error(
        "[worker:dispatcher] tick error:",
        err instanceof Error ? err.message : err,
      );
    });
  }, TICK_INTERVAL_MS);
  return () => clearInterval(handle);
}
