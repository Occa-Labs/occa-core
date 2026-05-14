// Chat-mode synthesis callback. Triggered by cascade-on-done when a
// task born from a CEO chat turn (originating_user_id set) finishes.
// The synthesis call wakes the CEO via the SAME chat session the user
// is talking on, hands it the subordinate's result, and posts the
// reply back as an assistant message — closing the
// USER → CEO → SUBORDINATE → CEO → USER loop.
//
// This service IS a chat turn, just one the system kicks off instead
// of the user. It reuses the adapter + chat repository so the user
// sees a normal-looking assistant message land in their CEO thread.

import { and, desc, eq } from "drizzle-orm";
import { stripOccaMarkers } from "@occa/shared/markers";
import type { ContentBlock } from "@occa/shared/types";
import { tasks, traces } from "@occa/shared/schema";
import { db } from "../../infra/database/client";
import { getAdapter } from "../../lib/adapter-registry";
import { childLogger } from "../../lib/logger";
import { AGENT_WAIT_TIMEOUT_MS } from "../../lib/timing";
import { findCeoForCompany } from "../../features/agents/repositories/deployments";
import { findByDeploymentId as findRuntimeProfile } from "../../features/agents/repositories/agent-runtime-profile";
import {
  earliestMessageId,
  insertMessage,
} from "../../features/chat/repositories/chat-messages";

const log = childLogger("services:delegation:synthesis");

// Cap on how much of the subordinate's output we inject back into the
// synthesis prompt. Long enough to fit a research brief / draft, short
// enough to keep token cost bounded. Long-form artifacts should be
// summarized by the subordinate; we don't want the synthesis turn to
// be the place where the full body lives.
const SUBORDINATE_OUTPUT_MAX = 6_000;

export interface SynthesizeArgs {
  taskId: string;
}

export type SynthesizeOutcome =
  | { ok: true; skipped?: "ceo_self_executed_via_report" }
  | {
      ok: false;
      reason:
        | "task_not_found"
        | "task_not_chat_origin"
        | "no_ceo"
        | "ceo_not_provisioned"
        | "adapter_unavailable"
        | "adapter_failed";
    };

// Build a text snapshot of the task's completed output. Brief comes
// from the task's `blocks` paragraph entries (what the subordinate
// was asked to do). Full result text lives in `traces.resultJson.text`
// — the dispatcher writes the cleaned reply there at close-trace time.
// We deliberately pull from the trace and not from `tasks.blocks`
// `agent_result.preview` because that preview is capped at 200 chars
// — far too short for synthesis to summarize a real artifact.
async function snapshotTaskOutput(
  task: typeof tasks.$inferSelect,
): Promise<{ brief: string; result: string }> {
  const taskBlocks = (task.blocks ?? []) as ContentBlock[];
  const briefBlocks = taskBlocks.filter((b) => b.type === "paragraph");
  const brief = briefBlocks
    .map((b) => (b.type === "paragraph" ? b.text : ""))
    .filter((s) => s.length > 0)
    .join("\n\n");

  // Most recent succeeded trace for this task carries the full reply.
  // Falls back to the agent_result preview (or empty) if no trace row
  // is found — shouldn't happen for a properly-closed task but defends
  // against partial-flush edge cases.
  const [latestTrace] = await db
    .select({ resultJson: traces.resultJson })
    .from(traces)
    .where(and(eq(traces.taskId, task.id), eq(traces.status, "succeeded")))
    .orderBy(desc(traces.finishedAt))
    .limit(1);
  let result = "";
  if (latestTrace?.resultJson && typeof latestTrace.resultJson === "object") {
    const rj = latestTrace.resultJson as Record<string, unknown>;
    if (typeof rj.text === "string") result = rj.text;
  }
  if (result.length === 0) {
    const resultBlock = taskBlocks.find((b) => b.type === "agent_result");
    if (resultBlock && resultBlock.type === "agent_result") {
      result = resultBlock.preview ?? "";
    }
  }

  return {
    brief: brief.slice(0, SUBORDINATE_OUTPUT_MAX),
    result: result.slice(0, SUBORDINATE_OUTPUT_MAX),
  };
}

// Two branches:
//   • "done"   — subordinate closed the task; synthesize the result.
//   • "review" — subordinate emitted [[OCCA:REVIEW]] and parked the task,
//     signalling they want human eyes before closing. Frame the chat
//     reply as "wants your review", surface the work-so-far, and ask
//     the user for direction. Do NOT pretend the task is finished.
function buildSynthesisPrompt(args: {
  taskTitle: string;
  subordinateName: string;
  brief: string;
  result: string;
  taskStatus: "done" | "review";
}): string {
  if (args.taskStatus === "review") {
    return [
      `[System wake — subordinate paused a task they delegated from chat and is asking for review before closing.]`,
      ``,
      `${args.subordinateName} submitted work on "${args.taskTitle}" but flagged it for review — they want your eyes on it before closing.`,
      ``,
      `What they were asked to do:`,
      args.brief || "(brief unavailable)",
      ``,
      `What they have so far:`,
      args.result || "(no result captured)",
      ``,
      `Reply to the owner in chat. Tell them clearly that ${args.subordinateName} is asking for review (NOT that the task is done). Surface the work-so-far + your read on it, then ask the owner what to do — approve, edit, or send back with notes. Plain markdown, no JSON. Do NOT emit any [[OCCA:*]] markers — your reply IS the chat message the owner will see.`,
    ].join("\n");
  }
  return [
    `[System wake — subordinate finished a task you delegated from chat.]`,
    ``,
    `${args.subordinateName} just completed: "${args.taskTitle}".`,
    ``,
    `What they were asked to do:`,
    args.brief || "(brief unavailable)",
    ``,
    `What they shipped:`,
    args.result || "(no result captured)",
    ``,
    `Reply to the owner in chat. Synthesize the result for them — key`,
    `findings, anything notable, suggested followups. Plain markdown,`,
    `no JSON. Do NOT emit any [[OCCA:*]] markers — your reply IS the`,
    `chat message the owner will see.`,
  ].join("\n");
}

export async function synthesizeCeoReplyForTask(
  args: SynthesizeArgs,
): Promise<SynthesizeOutcome> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, args.taskId));
  if (!task) {
    log.warn({ taskId: args.taskId }, "synthesis: task not found");
    return { ok: false, reason: "task_not_found" };
  }
  if (!task.originatingUserId) {
    return { ok: false, reason: "task_not_chat_origin" };
  }

  const ceo = await findCeoForCompany(task.companyId);
  if (!ceo) {
    log.warn(
      { taskId: task.id, companyId: task.companyId },
      "synthesis: no active CEO deployment",
    );
    return { ok: false, reason: "no_ceo" };
  }

  // Self-execute short-circuit. Narrowly scoped: only applies when the
  // CEO completed a self-assigned task by emitting [[OCCA:REPORT]] —
  // i.e. status reached `done`. In that case the dispatcher already
  // inserted the REPORT body as a chat row; synthesizing again would
  // post a duplicate.
  //
  // When CEO is assignee but status is `review`, NO chat row exists
  // yet (REVIEW / DELEGATE markers don't trigger a dispatcher insert).
  // We must let synthesis fire so the user gets a DM explaining what
  // the CEO is asking for (e.g. "I delegated to X" or "I need your
  // input on Y"). Skipping here would leave the user stuck.
  if (task.assignedDeploymentId === ceo.id && task.status === "done") {
    log.info(
      { taskId: task.id, ceoId: ceo.id },
      "synthesis skipped: CEO self-execute path already reported in task-mode",
    );
    return { ok: true, skipped: "ceo_self_executed_via_report" };
  }

  const profile = await findRuntimeProfile(ceo.id);
  if (!profile || !profile.externalAgentId) {
    log.warn(
      { taskId: task.id, ceoId: ceo.id },
      "synthesis: CEO not provisioned",
    );
    return { ok: false, reason: "ceo_not_provisioned" };
  }

  const adapter = getAdapter(profile.adapterType);
  if (!adapter) {
    log.warn(
      { taskId: task.id, adapterType: profile.adapterType },
      "synthesis: unknown adapter type",
    );
    return { ok: false, reason: "adapter_unavailable" };
  }

  // Synthesis only handles settled states (done / review). Other
  // statuses indicate cascade fired prematurely or via a path we don't
  // own; skip rather than wake CEO with stale context.
  if (task.status !== "done" && task.status !== "review") {
    log.info(
      { taskId: task.id, status: task.status },
      "synthesis skipped: task status is not done or review",
    );
    return { ok: true };
  }

  const subordinateName =
    task.assignedDeploymentId === ceo.id ? "You" : "your subordinate";
  const snapshot = await snapshotTaskOutput(task);
  const wakePrompt = buildSynthesisPrompt({
    taskTitle: task.title,
    subordinateName,
    brief: snapshot.brief,
    result: snapshot.result,
    taskStatus: task.status,
  });

  const startedAt = new Date();
  const [traceRow] = await db
    .insert(traces)
    .values({
      companyId: task.companyId,
      deploymentId: ceo.id,
      invocationSource: "chat",
      conversationId: `ceo-chat-${task.originatingUserId}`,
      actorType: "system",
      actorId: "ceo-synthesis",
      status: "running",
      startedAt,
    })
    .returning({ id: traces.id });
  const traceId = traceRow.id;

  const boundary = await earliestMessageId({
    companyId: task.companyId,
    deploymentId: ceo.id,
  });
  const suffix = boundary ? boundary.slice(0, 8) : "init";
  const sessionKey = `agent:${profile.externalAgentId}:chat:ceo-${task.originatingUserId}:${suffix}`;

  const cfg = (profile.adapterConfig ?? {}) as Record<string, unknown>;
  const result = await adapter.sendPrompt({
    adapterConfig: cfg,
    externalAgentId: profile.externalAgentId,
    sessionKey,
    message: wakePrompt,
    waitTimeoutMs: AGENT_WAIT_TIMEOUT_MS,
  });
  const finishedAt = new Date();

  if (!result.ok) {
    await db
      .update(traces)
      .set({
        status: "failed",
        finishedAt,
        error: result.reason ?? result.error,
        errorCode: result.error,
        updatedAt: finishedAt,
      })
      .where(eq(traces.id, traceId));
    log.warn(
      { taskId: task.id, traceId, error: result.error },
      "synthesis: adapter failed",
    );
    return { ok: false, reason: "adapter_failed" };
  }

  const cleanReply = stripOccaMarkers(result.reply);
  // `createdTaskId` is intentionally null: synthesis does NOT create a
  // task — it delivers the result of a task already completed elsewhere.
  // Stamping the task id here causes the UI to render a misleading
  // "Task created" badge on the synthesis bubble. The trace link is
  // sufficient for audit / navigation back to the run.
  await insertMessage({
    companyId: task.companyId,
    deploymentId: ceo.id,
    role: "assistant",
    content: cleanReply.length > 0 ? cleanReply : "(empty reply)",
    createdTaskId: null,
    traceId,
  });

  await db
    .update(traces)
    .set({
      status: "succeeded",
      finishedAt,
      resultJson: { text: result.reply },
      updatedAt: finishedAt,
    })
    .where(eq(traces.id, traceId));

  log.info(
    { taskId: task.id, traceId, replyBytes: cleanReply.length },
    "synthesis: CEO reply posted to chat",
  );
  return { ok: true };
}
