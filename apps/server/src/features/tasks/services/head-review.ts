// Auto-reviewer. Resolves a delegated deliverable that landed in
// `review` — without this, a task an agent self-routes to review
// via [[OCCA:REVIEW]] has no resolver and the autonomous loop stalls.
//
// Flow: the dispatcher enqueues `review.dispatch` for a delegated task
// that landed in `review`. This module wakes the Head that delegated it
// (`task.createdByDeploymentId`), shows it the deliverable, and asks for
// a review verdict via a [[OCCA:REVIEW_VERDICT]] block:
//   - approve → run the full done-path (finalizeTaskDone) → published
//   - revise  → bounce back to the writer with the Head's feedback
// Capped at MAX_REVIEW_ROUNDS Head reviews; past the cap the deliverable
// is auto-approved so the loop always terminates.
//
// The review runs server-side (the same engine as the task dispatcher —
// `adapter.sendPrompt`) rather than as a board task: a review is not a
// unit of work on the kanban, and the verdict's effects (publish, bounce)
// are server-feature code the worker cannot reach.

import { v4 as uuid } from "uuid";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import {
  agentIdentities,
  agentRuntimeProfile,
  companies,
  deployments,
  tasks,
  traceEvents,
  traces,
} from "@occa/shared/schema";
import { extractActionBlocks } from "@occa/shared/markers";
import type { ContentBlock } from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";
import { LIMITS } from "../../../lib/limits";
import { TASK_DISPATCH_TIMEOUT_MS } from "../../../lib/timing";
import { getAdapter } from "../../../lib/adapter-registry";
import { finalizeTaskDone } from "./finalize";
import { bounceTaskToAgent } from "./comments";
import { appendTaskEventBestEffort, listTaskEvents } from "./events";

const log = childLogger("services:tasks:head-review");

// Fallback for how many times a Head may review one task before the
// auto-reviewer stops asking and auto-rejects (keeps the writer↔Head loop
// bounded). The live value is per-company (`companies.max_review_rounds`,
// operator-tunable in Settings); this const only applies if that row is
// somehow missing.
const MAX_REVIEW_ROUNDS = 2;

type TaskRow = typeof tasks.$inferSelect;

// The Head's verdict. taskId is accepted but ignored — the task under
// review is known from the dispatch context; the field is a sanity hint
// only. feedback is required in spirit for `revise`/`reject` (the
// contract says so) but tolerated empty so a malformed reply never
// wedges the loop.
const reviewVerdictPayload = z.object({
  taskId: z.string().uuid().optional(),
  decision: z.enum(["approve", "revise", "reject"]),
  feedback: z.string().trim().max(LIMITS.DESCRIPTION).optional(),
});

// Inlined into the review prompt — agents do not reliably read workspace
// files, so the verdict contract must travel in the message itself.
const REVIEW_VERDICT_CONTRACT = [
  "Reply with EXACTLY ONE verdict block and nothing else of substance:",
  "",
  "[[OCCA:REVIEW_VERDICT]]",
  "{",
  '  "decision": "approve" | "revise" | "reject",',
  '  "feedback": "<your review note>"',
  "}",
  "[[/OCCA:REVIEW_VERDICT]]",
  "",
  "approve — the deliverable is published as-is. Downstream webhooks fire.",
  "          Use ONLY when the piece is publishable as it stands.",
  "          feedback is optional.",
  "revise  — sent back to the writer for a fix. The cycle continues; the",
  "          writer gets another shot. feedback is REQUIRED and must be",
  "          specific and actionable: what is wrong and what to change.",
  "reject  — kill this attempt. The task is archived, NO webhook fires,",
  "          no retry. Use when the deliverable cannot be salvaged: the",
  "          writer flagged unverifiable claims and the gap is upstream",
  "          (no primary source exists), the story does not clear the",
  "          publication bar, or the piece would mislead readers if",
  "          published. feedback is REQUIRED and must explain why the",
  "          piece cannot ship.",
  "",
  "Do NOT rewrite the piece yourself, do NOT delegate, do NOT spawn",
  "sub-agents. Your only job this turn is the verdict.",
].join("\n");

interface Verdict {
  decision: "approve" | "revise" | "reject";
  feedback: string;
}

// pg-boss entry point — handles one `review.dispatch` job.
export async function dispatchHeadReview(reviewTaskId: string): Promise<void> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, reviewTaskId))
    .limit(1);
  if (!task) {
    log.warn({ taskId: reviewTaskId }, "review task not found");
    return;
  }

  // Per-company review-round cap (operator-tunable in Settings). Falls back
  // to the module default if the company row is missing.
  const [companyRow] = await db
    .select({ maxReviewRounds: companies.maxReviewRounds })
    .from(companies)
    .where(eq(companies.id, task.companyId))
    .limit(1);
  const maxReviewRounds = companyRow?.maxReviewRounds ?? MAX_REVIEW_ROUNDS;
  // The task may have been resolved between enqueue and dispatch (a user
  // moved it, a retry already ran). Only act on a task still in review.
  if (task.status !== "review") {
    log.info(
      { taskId: reviewTaskId, status: task.status },
      "task no longer in review, skipping head review",
    );
    return;
  }
  const reviewerId = task.createdByDeploymentId;
  if (!reviewerId || reviewerId === task.assignedDeploymentId) {
    log.warn(
      { taskId: reviewTaskId },
      "no distinct reviewer for task, leaving in review",
    );
    return;
  }
  if (!task.assignedDeploymentId) {
    log.warn(
      { taskId: reviewTaskId },
      "review task has no assignee, leaving in review",
    );
    return;
  }

  // Load the writer's deliverable — the latest succeeded trace the
  // assignee produced for this task. Without it there is nothing to
  // review; leave the task parked.
  const deliverable = await loadDeliverable(
    reviewTaskId,
    task.assignedDeploymentId,
  );
  if (!deliverable) {
    log.warn(
      { taskId: reviewTaskId },
      "no deliverable trace found, leaving task in review",
    );
    return;
  }

  // Round cap: count verdicts already issued. Past the cap, auto-reject
  // rather than ask the Head again — the loop must always terminate and
  // a piece that needed 2+ revisions and still isn't clearing the bar is
  // safer killed than shipped. Auto-APPROVE here was the previous default
  // and meant a flagged piece could ship past the writer's REVIEW intent.
  const priorRounds = await countReviewRounds(reviewTaskId);
  if (priorRounds >= maxReviewRounds) {
    log.info(
      { taskId: reviewTaskId, priorRounds },
      "review round cap reached, auto-rejecting",
    );
    await recordVerdict(
      task,
      reviewerId,
      {
        decision: "reject",
        feedback: "Auto-rejected: review round cap reached without approval.",
      },
      deliverable.traceId,
      true,
    );
    const reviewer = await loadReviewer(reviewerId);
    if (reviewer) {
      await rejectReviewedTask({
        task,
        reviewer: { id: reviewer.id, name: reviewer.name },
        feedback: "Auto-rejected: review round cap reached without approval.",
        round: priorRounds + 1,
      });
    } else {
      // Reviewer record missing (rare). Still archive to avoid a stuck
      // task or accidental publish.
      await db
        .update(tasks)
        .set({
          archivedAt: new Date(),
          archiveReason: "review_rejected",
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, reviewTaskId));
    }
    return;
  }

  const reviewer = await loadReviewer(reviewerId);
  if (!reviewer) {
    log.warn({ taskId: reviewTaskId, reviewerId }, "reviewer not found");
    return;
  }
  const adapter = getAdapter(reviewer.adapterType);
  if (!adapter || !reviewer.externalAgentId) {
    log.warn(
      { taskId: reviewTaskId, reviewerId },
      "reviewer has no usable adapter, leaving task in review",
    );
    return;
  }

  const round = priorRounds + 1;
  const traceId = uuid();
  const startedAt = new Date();
  await openReviewTrace({ task, reviewerId, traceId, startedAt });

  const prompt = buildReviewPrompt({
    reviewerName: reviewer.name,
    task,
    deliverable: deliverable.text,
    round,
    maxRounds: maxReviewRounds,
  });
  const sessionKey = `agent:${reviewer.externalAgentId}:review:${traceId}`;

  // Capture the gateway's stream frames as `trace_events` rows so the
  // review run is inspectable in the trace view — without this the
  // review trace exists but shows no activity. Collected during the run
  // and bulk-inserted after it (no live SSE consumer watches a review).
  const reviewEvents: (typeof traceEvents.$inferInsert)[] = [];
  let evtSeq = 0;
  const onEvent = (stream: string, data: Record<string, unknown>): void => {
    evtSeq += 1;
    reviewEvents.push({
      companyId: task.companyId,
      traceId,
      deploymentId: reviewerId,
      seq: evtSeq,
      eventType: "stream",
      stream,
      payload: data,
    });
  };

  let result: Awaited<ReturnType<typeof adapter.sendPrompt>>;
  try {
    result = await adapter.sendPrompt({
      adapterConfig: (reviewer.adapterConfig ?? {}) as Record<string, unknown>,
      externalAgentId: reviewer.externalAgentId,
      sessionKey,
      message: prompt,
      onEvent,
      waitTimeoutMs: TASK_DISPATCH_TIMEOUT_MS,
    });
  } catch (err) {
    await persistReviewEvents(reviewEvents);
    await closeReviewTrace({
      traceId,
      finishedAt: new Date(),
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      text: null,
    });
    log.error(
      { err, taskId: reviewTaskId },
      "head review adapter threw, task left in review",
    );
    return;
  }
  await persistReviewEvents(reviewEvents);

  const finishedAt = new Date();
  if (!result.ok) {
    await closeReviewTrace({
      traceId,
      finishedAt,
      status: "failed",
      error: result.reason ?? result.error,
      text: null,
    });
    log.warn(
      { taskId: reviewTaskId, error: result.error },
      "head review trace failed, task left in review",
    );
    return;
  }
  await closeReviewTrace({
    traceId,
    finishedAt,
    status: "succeeded",
    error: null,
    text: result.reply,
  });

  const verdict = parseVerdict(result.reply);
  await recordVerdict(task, reviewerId, verdict, traceId, false);

  if (verdict.decision === "approve") {
    await finalizeTaskDone({
      taskId: reviewTaskId,
      deliverable: deliverable.text,
      traceId: deliverable.traceId,
    });
    log.info(
      { taskId: reviewTaskId, round },
      "head review approved, task finalized",
    );
    return;
  }

  if (verdict.decision === "reject") {
    // Reject = kill this attempt. Archive the task without calling
    // finalizeTaskDone — webhooks live in that path and we explicitly
    // do not want a rejected piece going to downstream subscribers.
    // The task stays searchable in the archived view; operators can
    // read the verdict feedback to understand why it was killed.
    await rejectReviewedTask({
      task,
      reviewer,
      feedback: verdict.feedback,
      round,
    });
    log.info(
      { taskId: reviewTaskId, round, reason: verdict.feedback },
      "head review rejected, task archived",
    );
    return;
  }

  // revise — bounce back to the writer with the Head's feedback. Same
  // mechanism the verification gate uses: comment + re-open + re-dispatch.
  await bounceTaskToAgent({
    taskId: reviewTaskId,
    companyId: task.companyId,
    assignedDeploymentId: task.assignedDeploymentId,
    body: buildReviseComment(
      reviewer.name,
      verdict.feedback,
      round,
      maxReviewRounds,
    ),
    // Bounce runs from the review.dispatch job, not the task's own
    // dispatch — dedupe on taskId so concurrent bounces of different
    // tasks do not collide on the exclusive queue's NULL-key slot.
    redispatchDedupe: true,
  });
  log.info(
    { taskId: reviewTaskId, round },
    "head review requested revision, task bounced to writer",
  );
}

// Reject handler — extracted so the main flow stays a verdict switch.
// Archives the task and posts a review-killed comment so the trail
// of "why didn't this publish?" is on the task itself, not just in
// task_events. Importantly does NOT call finalizeTaskDone (which fires
// webhooks) — a rejected piece must never reach downstream subscribers.
async function rejectReviewedTask(args: {
  task: TaskRow;
  reviewer: { id: string; name: string };
  feedback: string;
  round: number;
}): Promise<void> {
  const { task, reviewer, feedback, round } = args;
  const now = new Date();

  await db
    .update(tasks)
    .set({
      archivedAt: now,
      archiveReason: "review_rejected",
      updatedAt: now,
    })
    .where(eq(tasks.id, task.id));

  void appendTaskEventBestEffort({
    companyId: task.companyId,
    taskId: task.id,
    eventType: "task_archived",
    actorType: "system",
    actorId: "system",
    payload: {
      reason: "review_rejected",
      reviewerId: reviewer.id,
      reviewerName: reviewer.name,
      round,
      feedback,
    },
  });
}

// ── helpers ────────────────────────────────────────────────────────────

interface DeliverableRef {
  traceId: string;
  text: string;
}

async function loadDeliverable(
  taskId: string,
  assigneeId: string,
): Promise<DeliverableRef | null> {
  // Filter by the assignee deployment so a prior review trace (which
  // shares this taskId, but belongs to the Head) is never mistaken for
  // the writer's deliverable.
  const [row] = await db
    .select({ id: traces.id, resultJson: traces.resultJson })
    .from(traces)
    .where(
      and(
        eq(traces.taskId, taskId),
        eq(traces.deploymentId, assigneeId),
        eq(traces.status, "succeeded"),
      ),
    )
    .orderBy(desc(traces.finishedAt))
    .limit(1);
  if (!row) return null;
  const text = (row.resultJson as { text?: unknown } | null)?.text;
  if (typeof text !== "string" || !text.trim()) return null;
  return { traceId: row.id, text };
}

async function countReviewRounds(taskId: string): Promise<number> {
  const events = await listTaskEvents(taskId);
  return events.filter(
    (e) =>
      (e.payload as Record<string, unknown> | null)?.actionType ===
      "ReviewVerdict",
  ).length;
}

async function loadReviewer(deploymentId: string) {
  const [row] = await db
    .select({
      id: deployments.id,
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
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  return row ?? null;
}

interface OpenReviewTraceArgs {
  task: TaskRow;
  reviewerId: string;
  traceId: string;
  startedAt: Date;
}

// Opens an audit trace for the review run. Bound to the reviewed task
// (so it appears in that task's timeline) but it deliberately does NOT
// touch the task row — the task stays in `review` until the verdict
// resolves it, and `linkedTraceId` belongs to the writer's dispatch.
async function openReviewTrace(args: OpenReviewTraceArgs): Promise<void> {
  await db.insert(traces).values({
    id: args.traceId,
    companyId: args.task.companyId,
    deploymentId: args.reviewerId,
    taskId: args.task.id,
    invocationSource: "review",
    conversationId: args.task.id,
    actorType: "system",
    actorId: null,
    status: "running",
    startedAt: args.startedAt,
  });
}

interface CloseReviewTraceArgs {
  traceId: string;
  finishedAt: Date;
  status: "succeeded" | "failed";
  error: string | undefined | null;
  text: string | null;
}

// Persist the review run's captured stream frames. Best-effort — a
// failure here only loses trace history, it must not wedge the verdict.
async function persistReviewEvents(
  rows: (typeof traceEvents.$inferInsert)[],
): Promise<void> {
  if (rows.length === 0) return;
  try {
    await db.insert(traceEvents).values(rows);
  } catch (err) {
    log.error({ err }, "failed to persist review trace events (non-fatal)");
  }
}

async function closeReviewTrace(args: CloseReviewTraceArgs): Promise<void> {
  await db
    .update(traces)
    .set({
      status: args.status,
      finishedAt: args.finishedAt,
      updatedAt: args.finishedAt,
      error: args.error ?? null,
      resultJson: args.text ? { text: args.text } : null,
    })
    .where(eq(traces.id, args.traceId));
}

function parseVerdict(reply: string): Verdict {
  const block = extractActionBlocks(reply).find(
    (b) => b.token === "REVIEW_VERDICT",
  );
  if (!block) {
    // Fail safe: if the Head emits no verdict block, do NOT default to
    // publish. Reject the piece so a deliverable that nobody approved
    // can never reach downstream subscribers. Previously this defaulted
    // to approve, which let badly-formed reviewer replies pass garbage
    // through to the publish target.
    log.warn("no REVIEW_VERDICT block in reviewer reply, defaulting to reject");
    return {
      decision: "reject",
      feedback: "No verdict block emitted by the reviewer; auto-rejected.",
    };
  }
  const parsed = reviewVerdictPayload.safeParse(block.body);
  if (!parsed.success) {
    log.warn(
      { detail: parsed.error.flatten() },
      "invalid REVIEW_VERDICT payload, defaulting to reject",
    );
    return {
      decision: "reject",
      feedback: "Reviewer verdict could not be parsed; auto-rejected.",
    };
  }
  return {
    decision: parsed.data.decision,
    feedback: parsed.data.feedback ?? "",
  };
}

async function recordVerdict(
  task: TaskRow,
  reviewerId: string,
  verdict: Verdict,
  traceId: string,
  auto: boolean,
): Promise<void> {
  // Awaited (not fire-and-forget): the count of these events drives the
  // next round's cap decision, so it must be durable before this returns.
  await appendTaskEventBestEffort({
    companyId: task.companyId,
    taskId: task.id,
    eventType: "agent_action_emitted",
    actorType: auto ? "system" : "agent",
    actorId: auto ? "system" : reviewerId,
    payload: {
      actionType: "ReviewVerdict",
      channel: auto ? "system" : "block_marker",
      decision: verdict.decision,
      feedback: verdict.feedback,
      auto,
    },
    traceId,
  });
}

function taskBriefText(task: TaskRow): string {
  const blocks = (task.blocks ?? []) as ContentBlock[];
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "paragraph" }> =>
      b.type === "paragraph",
    )
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

interface BuildReviewPromptArgs {
  reviewerName: string;
  task: TaskRow;
  deliverable: string;
  round: number;
  maxRounds: number;
}

function buildReviewPrompt(args: BuildReviewPromptArgs): string {
  const { reviewerName, task, deliverable, round, maxRounds } = args;
  const brief = taskBriefText(task);
  const lines: string[] = [
    `Hello ${reviewerName}. A deliverable from a task you delegated is `,
    "ready for your review.",
    "",
    `Task: ${task.title}`,
  ];
  if (brief) {
    lines.push("", "Brief:", brief);
  }
  if (task.acceptanceCriteria) {
    lines.push("", `Acceptance criteria: ${task.acceptanceCriteria}`);
  }
  lines.push("", `Review round ${round} of ${maxRounds}.`);
  if (round >= maxRounds) {
    lines.push(
      "This is the final round — if you request revision again, the next " +
        "turn auto-approves regardless.",
    );
  }
  lines.push(
    "",
    "--- DELIVERABLE ---",
    deliverable,
    "--- END DELIVERABLE ---",
    "",
    "Judge the deliverable against the brief and acceptance criteria:",
    "accuracy, clarity, completeness, and fit. Hold a weak one; approve a sound one.",
    "",
    REVIEW_VERDICT_CONTRACT,
  );
  return lines.join("\n");
}

function buildReviseComment(
  reviewerName: string,
  feedback: string,
  round: number,
  maxRounds: number,
): string {
  return [
    `Review (round ${round} of ${maxRounds}) by ${reviewerName} — ` +
      "revision requested before this can be published:",
    "",
    feedback || "(no specific feedback provided)",
    "",
    "Address the points above and resubmit.",
  ].join("\n");
}
