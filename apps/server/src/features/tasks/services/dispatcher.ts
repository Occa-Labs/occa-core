// Task dispatcher — orchestrates one HTTP-driven dispatch cycle:
//   load → mark in_progress → call adapter → process reply → close.
//
// This file owns the lifecycle. Side-effects per phase live in the
// services/repositories it composes:
//   - services/context/render-task.ts builds the wake message via the
//     Context Pipeline (loadContext + renderTaskPrompt).
//   - action-blocks/parser.ts handles DELEGATE/BLOCK markers
//   - cascade.ts wakes parents on done
//   - events.ts persists task_event rows
//   - trace-events-bus pushes live SSE updates (existing system)
//
// Cross-feature primitive `canDeploy` comes in through `DispatchTaskDeps`.
// The composition root (queue worker) imports it and threads it through
// for action-block scope validation. Subordinate listing for prompts is
// now owned by the Context Pipeline directly.

import { v4 as uuid } from "uuid";
import { and, eq } from "drizzle-orm";
import {
  agentIdentities,
  agentRuntimeProfile,
  deployments,
  tasks,
  traces,
  traceEvents,
} from "@occa/shared/schema";
import {
  hasOccaMarker,
  stripOccaMarkers,
} from "@occa/shared/markers";
import type { ContentBlock, TaskStatus } from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import {
  AGENT_WAIT_TIMEOUT_MS,
  TRACE_EVENT_FLUSH_MS,
} from "../../../lib/timing";
import { childLogger } from "../../../lib/logger";
import { getAdapter } from "../../../lib/adapter-registry";
import { publishTraceEvent } from "../../../services/trace-events-bus";
import {
  nextStatusAfterDispatch,
  traceOutcomeFor,
} from "../domain/status-transitions";
import { processActionBlocks } from "./action-blocks/parser";
import type { ActionBlockDeps } from "./action-blocks/handlers";
import {
  loadContext,
  loadTaskSurfacePayload,
  renderTaskPrompt,
} from "../../../services/context";
import { cascadeOnTaskDone } from "./cascade";
import { autoSaveTaskAsDocument } from "../../../services/auto-save-document";
import { appendTaskEventBestEffort } from "./events";

const log = childLogger("services:tasks:dispatcher");

export type DispatchTaskDeps = ActionBlockDeps;

// Minimal agent row shape the dispatcher's helpers need (for opening
// traces and building events). The Context Pipeline now owns the
// "agent identity for prompt" concept — this shape is purely operational
// (adapter coordinates + identity for trace rows).
interface AgentRowForDispatch {
  id: string;
  companyId: string;
  role: string;
  name: string;
  adapterType: string;
  adapterConfig: unknown;
  externalAgentId: string | null;
}

export async function dispatchTask(
  taskId: string,
  deps: DispatchTaskDeps,
): Promise<void> {
  const taskRow = await loadDispatchableTask(taskId);
  if (!taskRow) return;

  const agentRow = await loadAgentForDispatch(
    taskRow.assignedDeploymentId!,
    taskRow.companyId,
  );
  if (!agentRow) return;

  const adapter = getAdapter(agentRow.adapterType);
  if (!adapter) {
    log.warn(
      { adapterType: agentRow.adapterType, deploymentId: agentRow.id },
      "unknown adapter type, skipping dispatch",
    );
    return;
  }
  if (!agentRow.externalAgentId) {
    log.warn(
      { deploymentId: agentRow.id },
      "agent missing externalAgentId, skipping dispatch",
    );
    return;
  }

  const startedAt = new Date();
  const traceId = uuid();
  await openTrace({ taskRow, agentRow, traceId, startedAt });
  emitDispatchStartedEvents({ taskRow, agentRow, traceId });
  publishTraceEvent(traceId, {
    seq: 0,
    eventType: "lifecycle",
    phase: "started",
    taskStatus: "in_progress",
    createdAt: startedAt.toISOString(),
  });

  const seqRef = { current: 1 };
  const cfg = (agentRow.adapterConfig ?? {}) as Record<string, unknown>;
  const gatewayUrl =
    typeof cfg.gatewayUrl === "string" ? cfg.gatewayUrl : null;
  const surface = await loadTaskSurfacePayload({
    task: taskRow,
    traceId,
    gatewayUrl,
  });
  const spec = await loadContext({
    deploymentId: agentRow.id,
    surface,
  });
  const message = renderTaskPrompt(spec);
  const sessionKey = `agent:${agentRow.externalAgentId}:task:${traceId}`;

  const flushHandle = createTraceEventFlusher({
    companyId: taskRow.companyId,
    deploymentId: agentRow.id,
    traceId,
    seqRef,
  });

  const result = await adapter.sendPrompt({
    adapterConfig: cfg,
    externalAgentId: agentRow.externalAgentId,
    sessionKey,
    message,
    onEvent: flushHandle.queueEvent,
    waitTimeoutMs: AGENT_WAIT_TIMEOUT_MS,
  });
  await flushHandle.drain();

  const finishedAt = new Date();

  if (!result.ok) {
    await closeFailedTrace({
      taskRow,
      agentRow,
      traceId,
      finishedAt,
      error: result.reason ?? result.error,
      errorCode: result.error,
    });
    publishTraceEvent(traceId, {
      seq: seqRef.current++,
      eventType: "lifecycle",
      phase: "failed",
      taskStatus: "todo",
      error: result.reason ?? result.error,
      createdAt: finishedAt.toISOString(),
    });
    return;
  }

  const needsReview = hasOccaMarker(result.reply, "REVIEW");
  if (needsReview) {
    void appendTaskEventBestEffort({
      companyId: taskRow.companyId,
      taskId: taskRow.id,
      eventType: "agent_action_emitted",
      actorType: "agent",
      actorId: agentRow.id,
      payload: { actionType: "REVIEW", channel: "block_marker" },
      traceId,
    });
  }

  const processed = await processActionBlocks(
    {
      reply: result.reply,
      agentId: agentRow.id,
      companyId: taskRow.companyId,
      currentTaskId: taskRow.id,
    },
    deps,
  );

  let approvalsRequested = 0;
  let blockedBy: string[] | null = null;
  let blockedReason: string | undefined;
  for (const r of processed) {
    if (r.outcome.kind === "approval_created") approvalsRequested += 1;
    if (r.outcome.kind === "blocked") {
      blockedBy = r.outcome.blockerIds;
      blockedReason = r.outcome.reason;
    }

    // Emit `agent_action_emitted` for every parsed marker, including
    // ignored ones. Ignored outcomes (invalid payload, scope failure,
    // self-blocker, etc.) are real audit signal — the agent tried to
    // emit something and we refused. Future workflow / janitor agents
    // need this to detect deviation patterns. The trace-event lifecycle
    // emission stays for live SSE consumers; the task-event row is the
    // durable audit copy.
    void appendTaskEventBestEffort({
      companyId: taskRow.companyId,
      taskId: taskRow.id,
      eventType: "agent_action_emitted",
      actorType: "agent",
      actorId: agentRow.id,
      payload: {
        actionType: r.token,
        channel: "block_marker",
        outcome: r.outcome.kind,
        ...(r.outcome.kind === "blocked"
          ? { blockerIds: r.outcome.blockerIds }
          : {}),
        ...(r.outcome.kind === "ignored"
          ? { reason: r.outcome.reason }
          : {}),
        actionPayload: r.body ?? null,
      },
      traceId,
    });
    if (r.outcome.kind === "ignored") {
      publishTraceEvent(traceId, {
        seq: seqRef.current++,
        eventType: "lifecycle",
        phase: "action_block_failed",
        token: r.token,
        error: r.outcome.reason,
        createdAt: new Date().toISOString(),
      });
    }
  }

  const nextStatus = nextStatusAfterDispatch({
    approvalsRequested,
    blockedBy,
    needsReview,
  });

  await closeSucceededTrace({
    taskRow,
    agentRow,
    traceId,
    finishedAt,
    cleanReply: stripOccaMarkers(result.reply),
    nextStatus,
    blockedBy,
    blockedReason,
  });

  publishTraceEvent(traceId, {
    seq: seqRef.current++,
    eventType: "lifecycle",
    phase: "completed",
    taskStatus: nextStatus,
    createdAt: finishedAt.toISOString(),
  });

  if (nextStatus === "done") {
    const cleanReply = stripOccaMarkers(result.reply);
    void autoSaveTaskAsDocument({
      taskId: taskRow.id,
      deploymentId: agentRow.id,
      cleanReply,
    }).catch((err) => {
      log.error(
        { err, taskId: taskRow.id },
        "autoSaveTaskAsDocument failed (non-fatal)",
      );
    });
    void cascadeOnTaskDone({ taskId: taskRow.id }).catch((err) => {
      log.error({ err, taskId: taskRow.id }, "cascadeOnTaskDone failed");
    });
  }
}

async function loadDispatchableTask(taskId: string) {
  const [taskRow] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!taskRow?.assignedDeploymentId) return null;
  // Defense-in-depth: even if two queue jobs slip past pg-boss
  // exclusivity, refuse to launch a second dispatcher for an active task.
  if (taskRow.status === "in_progress" && taskRow.linkedTraceId) {
    log.warn(
      { taskId, traceId: taskRow.linkedTraceId },
      "task already in_progress, skipping dispatch",
    );
    return null;
  }
  return taskRow;
}

async function loadAgentForDispatch(
  deploymentId: string,
  companyId: string,
): Promise<AgentRowForDispatch | null> {
  const [joined] = await db
    .select({
      id: deployments.id,
      companyId: deployments.companyId,
      role: deployments.role,
      name: agentIdentities.name,
      adapterType: agentRuntimeProfile.adapterType,
      adapterConfig: agentRuntimeProfile.adapterConfig,
      externalAgentId: agentRuntimeProfile.externalAgentId,
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
    .where(
      and(eq(deployments.id, deploymentId), eq(deployments.companyId, companyId)),
    )
    .limit(1);
  return joined ?? null;
}

interface OpenTraceArgs {
  taskRow: typeof tasks.$inferSelect;
  agentRow: AgentRowForDispatch;
  traceId: string;
  startedAt: Date;
}

async function openTrace({
  taskRow,
  agentRow,
  traceId,
  startedAt,
}: OpenTraceArgs): Promise<void> {
  await db.insert(traces).values({
    id: traceId,
    companyId: taskRow.companyId,
    deploymentId: agentRow.id,
    taskId: taskRow.id,
    invocationSource: "task",
    conversationId: taskRow.id, // task id doubles as conversation anchor
    actorType: "user",
    actorId: taskRow.createdByUserId,
    status: "running",
    startedAt,
  });
  await db
    .update(tasks)
    .set({
      status: "in_progress",
      linkedTraceId: traceId,
      updatedAt: startedAt,
    })
    .where(eq(tasks.id, taskRow.id));
}

function emitDispatchStartedEvents(args: {
  taskRow: typeof tasks.$inferSelect;
  agentRow: AgentRowForDispatch;
  traceId: string;
}): void {
  const { taskRow, agentRow, traceId } = args;
  void appendTaskEventBestEffort({
    companyId: taskRow.companyId,
    taskId: taskRow.id,
    eventType: "task_status_changed",
    actorType: "system",
    actorId: "system",
    payload: {
      from: taskRow.status,
      to: "in_progress",
      reason: "dispatch_started",
    },
    traceId,
  });
  void appendTaskEventBestEffort({
    companyId: taskRow.companyId,
    taskId: taskRow.id,
    eventType: "agent_trace_started",
    actorType: "agent",
    actorId: agentRow.id,
    payload: { traceId, deploymentId: agentRow.id },
    traceId,
  });
}

interface TraceEventFlusherArgs {
  companyId: string;
  deploymentId: string;
  traceId: string;
  seqRef: { current: number };
}

interface TraceEventFlusher {
  queueEvent: (stream: string, payload: Record<string, unknown>) => void;
  drain: () => Promise<void>;
}

// Adapter `onEvent` callback — pushes stream chunks to the live SSE bus
// instantly and batches them to `trace_events` for history. seq is shared
// with the dispatcher's lifecycle counter so action_block_* events
// emitted later in the flow don't clobber stream ordering.
function createTraceEventFlusher(
  args: TraceEventFlusherArgs,
): TraceEventFlusher {
  const pending: Array<typeof traceEvents.$inferInsert> = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = async (): Promise<void> => {
    flushTimer = null;
    if (!pending.length) return;
    const batch = pending.splice(0);
    try {
      await db.insert(traceEvents).values(batch);
    } catch {
      /* batched persistence is best-effort — bus already published */
    }
  };

  const queueEvent = (
    stream: string,
    payload: Record<string, unknown>,
  ): void => {
    const seq = args.seqRef.current++;
    const createdAt = new Date().toISOString();
    pending.push({
      companyId: args.companyId,
      traceId: args.traceId,
      deploymentId: args.deploymentId,
      seq,
      eventType: "stream",
      stream,
      payload,
    });
    if (!flushTimer) flushTimer = setTimeout(() => void flush(), TRACE_EVENT_FLUSH_MS);
    publishTraceEvent(args.traceId, {
      seq,
      eventType: "stream",
      stream,
      payload,
      createdAt,
    });
  };

  const drain = async (): Promise<void> => {
    if (flushTimer) clearTimeout(flushTimer);
    await flush();
  };

  return { queueEvent, drain };
}

interface CloseFailedArgs {
  taskRow: typeof tasks.$inferSelect;
  agentRow: AgentRowForDispatch;
  traceId: string;
  finishedAt: Date;
  error: string | undefined;
  errorCode: string | undefined;
}

async function closeFailedTrace(args: CloseFailedArgs): Promise<void> {
  const { taskRow, agentRow, traceId, finishedAt, error, errorCode } = args;
  await db
    .update(traces)
    .set({
      status: "failed",
      finishedAt,
      error,
      errorCode,
      updatedAt: finishedAt,
    })
    .where(eq(traces.id, traceId));
  await db
    .update(tasks)
    .set({ status: "todo", linkedTraceId: null, updatedAt: finishedAt })
    .where(eq(tasks.id, taskRow.id));

  void appendTaskEventBestEffort({
    companyId: taskRow.companyId,
    taskId: taskRow.id,
    eventType: "agent_trace_finished",
    actorType: "agent",
    actorId: agentRow.id,
    payload: { traceId, outcome: "error", error },
    traceId,
  });
  void appendTaskEventBestEffort({
    companyId: taskRow.companyId,
    taskId: taskRow.id,
    eventType: "task_status_changed",
    actorType: "system",
    actorId: "system",
    payload: { from: "in_progress", to: "todo", reason: "trace_failed" },
    traceId,
  });
}

interface CloseSucceededArgs {
  taskRow: typeof tasks.$inferSelect;
  agentRow: AgentRowForDispatch;
  traceId: string;
  finishedAt: Date;
  cleanReply: string;
  nextStatus: TaskStatus;
  blockedBy: string[] | null;
  blockedReason: string | undefined;
}

async function closeSucceededTrace(args: CloseSucceededArgs): Promise<void> {
  const { taskRow, agentRow, traceId, finishedAt, cleanReply, nextStatus } =
    args;
  const preview = cleanReply.slice(0, 200);

  await db
    .update(traces)
    .set({
      status: "succeeded",
      finishedAt,
      resultJson: { text: cleanReply },
      updatedAt: finishedAt,
    })
    .where(eq(traces.id, traceId));

  const agentResultBlock: ContentBlock = {
    type: "agent_result",
    traceId,
    agentId: agentRow.id,
    agentName: agentRow.name,
    timestamp: finishedAt.toISOString(),
    preview,
  };
  const currentBlocks = ((taskRow.blocks ?? []) as ContentBlock[]).filter(
    (b) => b.type !== "agent_result",
  );

  await db
    .update(tasks)
    .set({
      status: nextStatus,
      linkedTraceId: null,
      blocks: [...currentBlocks, agentResultBlock],
      ...(args.blockedBy ? { blockedByTaskIds: args.blockedBy } : {}),
      updatedAt: finishedAt,
    })
    .where(eq(tasks.id, taskRow.id));

  void appendTaskEventBestEffort({
    companyId: taskRow.companyId,
    taskId: taskRow.id,
    eventType: "agent_trace_finished",
    actorType: "agent",
    actorId: agentRow.id,
    payload: { traceId, outcome: traceOutcomeFor(nextStatus) },
    traceId,
  });
  void appendTaskEventBestEffort({
    companyId: taskRow.companyId,
    taskId: taskRow.id,
    eventType: "task_status_changed",
    actorType: "system",
    actorId: "system",
    payload: { from: "in_progress", to: nextStatus, reason: "trace_finished" },
    traceId,
  });
  if (args.blockedBy) {
    void appendTaskEventBestEffort({
      companyId: taskRow.companyId,
      taskId: taskRow.id,
      eventType: "task_blocked",
      actorType: "agent",
      actorId: agentRow.id,
      payload: {
        blockedByTaskIds: args.blockedBy,
        ...(args.blockedReason ? { reason: args.blockedReason } : {}),
      },
      traceId,
    });
  }
}
