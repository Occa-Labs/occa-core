import { and, eq, inArray } from "drizzle-orm";
import { agentIdentities, deployments, tasks } from "@occa/shared/schema";
import { extractActionBlocks } from "@occa/shared/markers";
import type {
  ContentBlock,
  LivenessState,
  TaskStatus,
} from "@occa/shared/types";
import { db } from "./db";
import { appendTaskEventBestEffort } from "./task-events";

// Auto-advance kanban status based on trace lifecycle:
//  - `todo` → `in_progress` when a trace starts against the task
//  - `in_progress` → `done` (or `review`) when a trace succeeds with a real reply
//  - liveness ≠ normal → stay at `in_progress`; continuation will re-trigger
//  - failed/timed_out traces (retry exhausted) → archive the task with a
//    failure block so the kanban doesn't pile up. See syncTaskOnTraceFailed.
//
// On success we also append an `agent_result` block to the task body so the
// user sees inline what the agent produced. Full text stays on the trace;
// the block carries a short preview + traceId pointer for on-demand fetch.

const REVIEW_MARKER = /\[\[\s*OCCA\s*:\s*REVIEW\s*\]\]/i;
const PREVIEW_MAX_CHARS = 280;

async function loadTaskStatusAndBlocks(
  taskId: string,
): Promise<{
  status: TaskStatus;
  blocks: ContentBlock[];
  companyId: string;
} | null> {
  const [row] = await db
    .select({
      status: tasks.status,
      blocks: tasks.blocks,
      companyId: tasks.companyId,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!row) return null;
  return {
    status: row.status as TaskStatus,
    blocks: (row.blocks as ContentBlock[] | null) ?? [],
    companyId: row.companyId,
  };
}

async function setTaskStatus(
  taskId: string,
  from: TaskStatus[],
  to: TaskStatus,
): Promise<boolean> {
  const res = await db
    .update(tasks)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, from)));
  // drizzle's update returns void; query rowCount via pg. But eq+inArray guards
  // idempotency — re-running is safe.
  void res;
  return true;
}

async function appendBlocks(
  taskId: string,
  blocks: ContentBlock[],
): Promise<void> {
  await db
    .update(tasks)
    .set({ blocks, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
}

export async function syncTaskOnTraceStart(
  taskId: string | null,
  ctx?: { traceId: string; deploymentId: string },
): Promise<void> {
  if (!taskId) return;
  const row = await loadTaskStatusAndBlocks(taskId);
  if (!row) return;
  // Kick it off the backlog/todo column once; never regress completed work.
  if (row.status === "todo") {
    await setTaskStatus(taskId, ["todo"], "in_progress");
    if (ctx) {
      void appendTaskEventBestEffort({
        companyId: row.companyId,
        taskId,
        eventType: "task_status_changed",
        actorType: "system",
        actorId: "system",
        payload: { from: "todo", to: "in_progress", reason: "trace_started" },
        traceId: ctx.traceId,
      });
    }
  }
  if (ctx) {
    void appendTaskEventBestEffort({
      companyId: row.companyId,
      taskId,
      eventType: "agent_trace_started",
      actorType: "agent",
      actorId: ctx.deploymentId,
      payload: { traceId: ctx.traceId, deploymentId: ctx.deploymentId },
      traceId: ctx.traceId,
    });
  }
}

function extractResponseText(
  resultJson: Record<string, unknown> | null,
): string {
  if (!resultJson) return "";
  if (typeof resultJson.text === "string") return resultJson.text;
  if (typeof resultJson.message === "string") return resultJson.message;
  return "";
}

// Truncate on a word boundary so the preview doesn't chop mid-word. Also
// collapse whitespace so multi-line output reads as a single-line excerpt.
function buildPreview(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  if (flattened.length <= PREVIEW_MAX_CHARS) return flattened;
  const cut = flattened.slice(0, PREVIEW_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  const safe = lastSpace > PREVIEW_MAX_CHARS - 40 ? cut.slice(0, lastSpace) : cut;
  return `${safe}…`;
}

async function loadAgentName(deploymentId: string): Promise<string> {
  const [row] = await db
    .select({ name: agentIdentities.name })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  return row?.name ?? "agent";
}

export async function syncTaskOnTraceSucceeded(args: {
  taskId: string | null;
  traceId: string;
  agentId: string;
  livenessState: LivenessState | null;
  resultJson: Record<string, unknown> | null;
  finishedAt: Date;
}): Promise<void> {
  if (!args.taskId) return;
  // Agent didn't actually produce a real response — leave the card alone so
  // the continuation loop can try again.
  if (args.livenessState && args.livenessState !== "normal") return;

  const responseText = extractResponseText(args.resultJson);
  if (!responseText.trim()) return;

  const needsReview = REVIEW_MARKER.test(responseText);
  const emittedActionBlocks = extractActionBlocks(responseText);
  const hasDelegate = emittedActionBlocks.some((b) => b.token === "DELEGATE");
  // DELEGATE wins over REVIEW. A task that just spawned children isn't
  // review-ready — the real work is happening in the children, so it stays
  // in_progress until they complete and it synthesizes for real. cascade.ts
  // re-wakes the orchestrator when each child settles.
  //
  // Priority matters: if an agent emits BOTH [[OCCA:REVIEW]] and a DELEGATE
  // (the CEO/head prompts sometimes do), routing to "review" would settle
  // this task immediately. cascade.ts settles-wakes the PARENT the moment
  // every sibling is settled, so a delegating-but-"review" task would wake
  // its parent one tier up, re-run that agent, and let it re-delegate — to a
  // different target, slipping past the same-target no-loop guard in
  // delegation.ts — duplicating the whole subtree. Keeping it in_progress
  // closes that loop.
  const target: TaskStatus = hasDelegate
    ? "in_progress"
    : needsReview
      ? "review"
      : "done";

  // Append a result block. Drop empty trailing paragraph so fresh tasks (which
  // start with a single blank paragraph) don't render an awkward gap.
  const row = await loadTaskStatusAndBlocks(args.taskId);
  if (!row) return;

  const agentName = await loadAgentName(args.agentId);
  const resultBlock: ContentBlock = {
    type: "agent_result",
    traceId: args.traceId,
    agentId: args.agentId,
    agentName,
    timestamp: args.finishedAt.toISOString(),
    preview: buildPreview(responseText),
  };

  const trimmed =
    row.blocks.length > 0 &&
    row.blocks[row.blocks.length - 1].type === "paragraph" &&
    !(row.blocks[row.blocks.length - 1] as { text: string }).text.trim()
      ? row.blocks.slice(0, -1)
      : row.blocks;
  await appendBlocks(args.taskId, [...trimmed, resultBlock]);

  // Only advance from active states — never resurrect a user-cancelled or
  // already-closed task.
  await setTaskStatus(args.taskId, ["todo", "in_progress"], target);

  void appendTaskEventBestEffort({
    companyId: row.companyId,
    taskId: args.taskId,
    eventType: "agent_trace_finished",
    actorType: "agent",
    actorId: args.agentId,
    payload: {
      traceId: args.traceId,
      outcome: needsReview ? "review" : "success",
    },
    traceId: args.traceId,
  });
  if (target !== row.status) {
    void appendTaskEventBestEffort({
      companyId: row.companyId,
      taskId: args.taskId,
      eventType: "task_status_changed",
      actorType: "system",
      actorId: "system",
      payload: { from: row.status, to: target, reason: "trace_succeeded" },
      traceId: args.traceId,
    });
  }
  // Mirror the server dispatcher's REVIEW-marker emission so cron-driven
  // traces also land an `agent_action_emitted` row in the audit log.
  if (needsReview) {
    void appendTaskEventBestEffort({
      companyId: row.companyId,
      taskId: args.taskId,
      eventType: "agent_action_emitted",
      actorType: "agent",
      actorId: args.agentId,
      payload: { actionType: "REVIEW", channel: "block_marker" },
      traceId: args.traceId,
    });
  }

  // DELEGATE markers are handled by executeWorkerDelegations in
  // dispatcher.ts, which emits its own audit per block with the real
  // outcome (delegated / ignored:<reason>). Nothing to do here.
  //
  // BLOCK markers have no worker-side handler yet (0 occurrences in
  // prod history at cleanup time). When one fires, port handleBlockBlock
  // from apps/server/src/services/delegation/markers/handlers.ts.
}

// Generic terminal-failure sync. Mirrors syncTaskOnTraceSucceeded but for
// non-success trace outcomes (failed-no-retry, timed_out, dispatcher_crash).
// Without this, every failed trace leaves its task pinned at in_progress
// and the kanban accumulates dead cards until someone archives them by
// hand — the routine wrapper pile-up that prompted this helper.
//
// Behavior is intentionally symmetric across all callers (routine,
// chat-origin, manual, delegated child): append a failure block, audit
// the transition, archive the task. Archive is the deterministic option
// because there is no "task failed" status in TASK_STATUSES — surfacing
// to `review` would keep the card around but require manual cleanup,
// which is exactly the loop we're closing here. Archived tasks remain
// fully searchable; users can unarchive if they want to retry.
export async function syncTaskOnTraceFailed(args: {
  taskId: string | null;
  traceId: string;
  agentId: string;
  outcome: "failed" | "timed_out" | "cancelled";
  errorCode: string | null;
  errorMessage: string | null;
  finishedAt: Date;
}): Promise<void> {
  if (!args.taskId) return;

  const row = await loadTaskStatusAndBlocks(args.taskId);
  if (!row) return;
  // Already archived (e.g. by a parallel worker tick) — nothing to do.
  if (row.status === "done") return;

  const agentName = await loadAgentName(args.agentId);
  const summary =
    args.outcome === "timed_out"
      ? `Trace timed out (${args.errorMessage ?? "no detail"}).`
      : args.outcome === "cancelled"
        ? `Trace cancelled.`
        : `Trace failed${
            args.errorCode ? ` [${args.errorCode}]` : ""
          }${args.errorMessage ? `: ${args.errorMessage}` : ""}.`;

  const failureBlock: ContentBlock = {
    type: "agent_result",
    traceId: args.traceId,
    agentId: args.agentId,
    agentName,
    timestamp: args.finishedAt.toISOString(),
    preview: summary.slice(0, PREVIEW_MAX_CHARS),
  };

  const trimmed =
    row.blocks.length > 0 &&
    row.blocks[row.blocks.length - 1].type === "paragraph" &&
    !(row.blocks[row.blocks.length - 1] as { text: string }).text.trim()
      ? row.blocks.slice(0, -1)
      : row.blocks;
  await appendBlocks(args.taskId, [...trimmed, failureBlock]);

  await db
    .update(tasks)
    .set({
      archivedAt: args.finishedAt,
      archiveReason: `trace_${args.outcome}`,
      updatedAt: args.finishedAt,
    })
    .where(eq(tasks.id, args.taskId));

  void appendTaskEventBestEffort({
    companyId: row.companyId,
    taskId: args.taskId,
    eventType: "task_archived",
    actorType: "system",
    actorId: "system",
    payload: {
      reason: `trace_${args.outcome}`,
      traceId: args.traceId,
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
    },
    traceId: args.traceId,
  });
}
