// Phase C cascade-bubble synthesis.
//
// Unified synthesizer for both user_ceo and agent_dm chat threads. The
// cascade-on-task-settled trigger calls `synthesizeForThread` with the
// task as the source artifact; the function:
//   1. Loads the originating thread (user_ceo or agent_dm).
//   2. Resolves the speaker (CEO for user_ceo, callee for agent_dm) and
//      the recipient framing (owner vs caller).
//   3. Wakes the speaker via the same chat session (sessionKey suffixed
//      by thread id) and asks them to synthesise the artifact.
//   4. Inserts the synthesised reply as an assistant message in the
//      thread.
//   5. If the thread is agent_dm AND has a parentThreadId, RECURSIVELY
//      invokes itself with the just-inserted reply as the new artifact —
//      bubbling the synthesis up one tier at a time until it reaches
//      the user_ceo root.
//
// This recursion depth is bounded by hierarchy depth (typically ≤3
// layers in OCCA's startup-flat model), so there's no stack-overflow
// risk. Each recursive layer is one adapter call.

import { and, desc, eq, sql } from "drizzle-orm";
import { stripOccaMarkers } from "@occa/shared/markers";
import type { ContentBlock } from "@occa/shared/types";
import {
  agentIdentities,
  chatThreads,
  deployments,
  tasks,
  traces,
} from "@occa/shared/schema";
import { roleLabelFor } from "@occa/shared/role-catalog";
import { db } from "../../infra/database/client";
import { getAdapter } from "../../lib/adapter-registry";
import { childLogger } from "../../lib/logger";
import { TASK_DISPATCH_TIMEOUT_MS } from "../../lib/timing";
import { threadSessionKey } from "../../lib/session-keys";
import { findByDeploymentId as findRuntimeProfile } from "../../features/agents/repositories/agent-runtime-profile";
import { insertMessage } from "../../features/chat/repositories/chat-messages";

const log = childLogger("services:delegation:synthesis");

const SUBORDINATE_OUTPUT_MAX = 6_000;

export type SourceArtifact =
  | { kind: "task"; taskId: string }
  | {
      kind: "dm_reply";
      // The work originally requested at this thread layer — used as the
      // "brief" context so the speaker knows what they were asking for.
      brief: string;
      // The synthesised reply from the layer below (already a clean
      // markdown summary, no markers).
      reply: string;
      // Name of the agent that produced the reply.
      authorName: string;
      authorRole: string;
    };

export type SynthesizeOutcome =
  | {
      ok: true;
      skipped?:
        | "ceo_self_executed_via_report"
        | "task_has_pending_children"
        | "thread_kind_unknown";
    }
  | {
      ok: false;
      reason:
        | "task_not_found"
        | "task_not_chat_origin"
        | "thread_not_found"
        | "speaker_not_configured"
        | "adapter_unavailable"
        | "adapter_failed";
    };

async function snapshotTaskOutput(
  task: typeof tasks.$inferSelect,
): Promise<{ brief: string; result: string }> {
  const taskBlocks = (task.blocks ?? []) as ContentBlock[];
  const briefBlocks = taskBlocks.filter((b) => b.type === "paragraph");
  const brief = briefBlocks
    .map((b) => (b.type === "paragraph" ? b.text : ""))
    .filter((s) => s.length > 0)
    .join("\n\n");

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

interface SpeakerIdentity {
  deploymentId: string;
  name: string;
  role: string;
  externalAgentId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}

async function loadSpeakerForThread(
  threadDeploymentId: string,
): Promise<SpeakerIdentity | null> {
  const [row] = await db
    .select({
      deploymentId: deployments.id,
      role: deployments.role,
      identityName: agentIdentities.name,
    })
    .from(deployments)
    .leftJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(eq(deployments.id, threadDeploymentId))
    .limit(1);
  if (!row) return null;

  const profile = await findRuntimeProfile(row.deploymentId);
  if (!profile || !profile.externalAgentId) return null;
  return {
    deploymentId: row.deploymentId,
    name: row.identityName ?? roleLabelFor(row.role),
    role: row.role,
    externalAgentId: profile.externalAgentId,
    adapterType: profile.adapterType,
    adapterConfig: (profile.adapterConfig ?? {}) as Record<string, unknown>,
  };
}

async function resolveCallerIdentity(
  callerDeploymentId: string | null,
): Promise<{ name: string; role: string }> {
  if (!callerDeploymentId) {
    return { name: "the System", role: "automation" };
  }
  const [row] = await db
    .select({
      role: deployments.role,
      identityName: agentIdentities.name,
    })
    .from(deployments)
    .leftJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(eq(deployments.id, callerDeploymentId))
    .limit(1);
  if (!row) return { name: "Unknown caller", role: "unknown" };
  return {
    name: row.identityName ?? roleLabelFor(row.role),
    role: roleLabelFor(row.role),
  };
}

function buildPromptForUserCeoThread(args: {
  artifact: SourceArtifact;
  taskTitle: string;
  speakerSelfReference: string;
  artifactBrief: string;
  artifactResult: string;
  taskStatus?: "done" | "review";
}): string {
  if (args.artifact.kind === "task" && args.taskStatus === "review") {
    return [
      `[System wake — subordinate paused a task they delegated from chat and is asking for review before closing.]`,
      ``,
      `${args.speakerSelfReference} submitted work on "${args.taskTitle}" but flagged it for review — they want your eyes on it before closing.`,
      ``,
      `What they were asked to do:`,
      args.artifactBrief || "(brief unavailable)",
      ``,
      `What they have so far:`,
      args.artifactResult || "(no result captured)",
      ``,
      `Reply to the owner in chat. Tell them clearly that ${args.speakerSelfReference} is asking for review (NOT that the task is done). Surface the work-so-far + your read on it, then ask the owner what to do — approve, edit, or send back with notes. Plain markdown, no JSON. Do NOT emit any [[OCCA:*]] markers — your reply IS the chat message the owner will see.`,
    ].join("\n");
  }
  return [
    `[System wake — work you routed via chat has completed.]`,
    ``,
    `${args.speakerSelfReference} just completed: "${args.taskTitle}".`,
    ``,
    `What was asked:`,
    args.artifactBrief || "(brief unavailable)",
    ``,
    `What was shipped:`,
    args.artifactResult || "(no result captured)",
    ``,
    `Reply to the owner in chat. Synthesize the result for them — key`,
    `findings, anything notable, suggested followups. Plain markdown,`,
    `no JSON. Do NOT emit any [[OCCA:*]] markers — your reply IS the`,
    `chat message the owner will see.`,
  ].join("\n");
}

function buildPromptForAgentDmThread(args: {
  callerName: string;
  callerRole: string;
  artifactBrief: string;
  artifactResult: string;
  artifactTitle: string;
}): string {
  return [
    `[System wake — work you delegated has completed.]`,
    ``,
    `Subordinate work for "${args.artifactTitle}" is in.`,
    ``,
    `What ${args.callerName} (${args.callerRole}) originally asked you for:`,
    args.artifactBrief || "(brief unavailable)",
    ``,
    `What your subordinate produced:`,
    args.artifactResult || "(no result captured)",
    ``,
    `Reply back to ${args.callerName} with a synthesised summary of the`,
    `work — key findings, anything notable, suggested followups. Plain`,
    `markdown, no JSON. Do NOT emit any [[OCCA:*]] markers — your reply`,
    `IS the message ${args.callerName} will see.`,
  ].join("\n");
}

export interface SynthesizeForThreadArgs {
  threadId: string;
  artifact: SourceArtifact;
  // Optional: when invoked by cascade for a task that's still in review
  // (DELEGATE markers fired, no children yet shipped a final), the
  // speaker should be told it's a review request, not a deliverable.
  taskStatusHint?: "done" | "review";
  // Internal recursion depth guard. Bumped on each recursive parent
  // call so a misconfigured chain can't pin the worker.
  depth?: number;
}

const MAX_RECURSION_DEPTH = 10;

export async function synthesizeForThread(
  args: SynthesizeForThreadArgs,
): Promise<SynthesizeOutcome> {
  const depth = args.depth ?? 0;
  if (depth > MAX_RECURSION_DEPTH) {
    log.error(
      { threadId: args.threadId, depth },
      "synthesizeForThread: recursion depth cap exceeded — aborting bubble",
    );
    return { ok: true, skipped: "thread_kind_unknown" };
  }

  const [thread] = await db
    .select()
    .from(chatThreads)
    .where(eq(chatThreads.id, args.threadId))
    .limit(1);
  if (!thread) {
    log.warn({ threadId: args.threadId }, "synthesis: thread not found");
    return { ok: false, reason: "thread_not_found" };
  }

  const speaker = await loadSpeakerForThread(thread.deploymentId);
  if (!speaker) {
    log.warn(
      { threadId: args.threadId, threadDeploymentId: thread.deploymentId },
      "synthesis: speaker not configured",
    );
    return { ok: false, reason: "speaker_not_configured" };
  }

  // Resolve artifact data needed by the prompt.
  let artifactBrief = "";
  let artifactResult = "";
  let artifactTitle = "(unknown)";
  if (args.artifact.kind === "task") {
    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, args.artifact.taskId));
    if (!task) {
      log.warn({ taskId: args.artifact.taskId }, "synthesis: task not found");
      return { ok: false, reason: "task_not_found" };
    }
    // For user_ceo threads, preserve the existing CEO self-execute
    // short-circuit: if the CEO was the assignee and reached done, the
    // dispatcher already inserted a REPORT chat row — duplicating here
    // would post twice.
    if (
      thread.kind === "user_ceo" &&
      task.assignedDeploymentId === speaker.deploymentId &&
      task.status === "done"
    ) {
      log.info(
        { taskId: task.id, speaker: speaker.deploymentId },
        "synthesis skipped: speaker self-execute already reported in task-mode",
      );
      return { ok: true, skipped: "ceo_self_executed_via_report" };
    }

    // Pending-children guard. When the task is in `review` because the
    // speaker just emitted DELEGATE (delegationsSpawned), the next
    // cascade-on-child-done will re-run synthesis with content in hand.
    // Skip now to avoid empty-reply bubbles.
    if (task.status === "review") {
      const [pendingChild] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.parentTaskId, task.id),
            sql`${tasks.status} NOT IN ('done', 'review')`,
          ),
        )
        .limit(1);
      if (pendingChild) {
        log.info(
          { taskId: task.id, pendingChildId: pendingChild.id },
          "synthesis skipped: task has pending children",
        );
        return { ok: true, skipped: "task_has_pending_children" };
      }
    }

    if (task.status !== "done" && task.status !== "review") {
      log.info(
        { taskId: task.id, status: task.status },
        "synthesis skipped: task status is not settled",
      );
      return { ok: true };
    }

    const snapshot = await snapshotTaskOutput(task);
    artifactBrief = snapshot.brief;
    artifactResult = snapshot.result;
    artifactTitle = task.title;
  } else {
    artifactBrief = args.artifact.brief;
    artifactResult = args.artifact.reply;
    artifactTitle = "(passed through from sub-thread)";
  }

  // Build the wake prompt — frame differs per thread kind.
  let wakePrompt: string;
  let conversationId: string;
  if (thread.kind === "user_ceo") {
    const speakerSelfRef =
      args.artifact.kind === "task"
        ? "Your subordinate"
        : `${(args.artifact as { authorName: string }).authorName}`;
    wakePrompt = buildPromptForUserCeoThread({
      artifact: args.artifact,
      taskTitle: artifactTitle,
      speakerSelfReference: speakerSelfRef,
      artifactBrief,
      artifactResult,
      taskStatus:
        args.artifact.kind === "task" ? args.taskStatusHint : undefined,
    });
    conversationId = `user-ceo-thread-${thread.id}`;
  } else if (thread.kind === "agent_dm") {
    const caller = await resolveCallerIdentity(thread.callerDeploymentId);
    wakePrompt = buildPromptForAgentDmThread({
      callerName: caller.name,
      callerRole: caller.role,
      artifactBrief,
      artifactResult,
      artifactTitle,
    });
    conversationId = `agent-dm-${thread.id}`;
  } else {
    log.warn(
      { threadId: thread.id, kind: thread.kind },
      "synthesis: unknown thread kind",
    );
    return { ok: true, skipped: "thread_kind_unknown" };
  }

  const adapter = getAdapter(speaker.adapterType);
  if (!adapter) {
    log.warn(
      { threadId: thread.id, adapterType: speaker.adapterType },
      "synthesis: unknown adapter type",
    );
    return { ok: false, reason: "adapter_unavailable" };
  }

  const startedAt = new Date();
  const [traceRow] = await db
    .insert(traces)
    .values({
      companyId: thread.companyId,
      deploymentId: speaker.deploymentId,
      invocationSource: "chat",
      conversationId,
      actorType: "system",
      actorId: "synthesis",
      status: "running",
      startedAt,
    })
    .returning({ id: traces.id });
  const traceId = traceRow.id;

  // Same gateway session as the thread's interactive turns (chat-handler
  // / agent-dm-handler) — so the report this synthesis posts lands in the
  // conversation memory the agent reads on the next user reply. See
  // `lib/session-keys`.
  const sessionKey = threadSessionKey(
    speaker.externalAgentId,
    thread.id,
    thread.resetGeneration,
  );
  const result = await adapter.sendPrompt({
    adapterConfig: speaker.adapterConfig,
    externalAgentId: speaker.externalAgentId,
    sessionKey,
    message: wakePrompt,
    waitTimeoutMs: TASK_DISPATCH_TIMEOUT_MS,
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
      { threadId: thread.id, traceId, error: result.error },
      "synthesis: adapter failed",
    );
    return { ok: false, reason: "adapter_failed" };
  }

  const cleanReply = stripOccaMarkers(result.reply);
  await insertMessage({
    threadId: thread.id,
    companyId: thread.companyId,
    deploymentId: speaker.deploymentId,
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
    {
      threadId: thread.id,
      kind: thread.kind,
      replyBytes: cleanReply.length,
      traceId,
    },
    "synthesis reply posted to thread",
  );

  // Recursive bubble: if this was an agent_dm and there's a parent
  // thread, wake the parent's speaker with this reply as the artifact.
  // The recursion terminates naturally when we hit a user_ceo thread
  // (kind=user_ceo, parentThreadId=null) — that's the user surface.
  if (thread.kind === "agent_dm" && thread.parentThreadId) {
    log.info(
      { threadId: thread.id, parentThreadId: thread.parentThreadId },
      "bubbling synthesis up to parent thread",
    );
    await synthesizeForThread({
      threadId: thread.parentThreadId,
      artifact: {
        kind: "dm_reply",
        brief: artifactBrief,
        reply: cleanReply,
        authorName: speaker.name,
        authorRole: roleLabelFor(speaker.role),
      },
      depth: depth + 1,
    });
  }

  return { ok: true };
}

// Backwards-compatible entry for cascade. Cascade still has the taskId,
// not the threadId. We look up the task to find the originating thread
// then delegate to the unified bubble.
export async function synthesizeForTask(args: {
  taskId: string;
}): Promise<SynthesizeOutcome> {
  const [task] = await db
    .select({
      id: tasks.id,
      originatingThreadId: tasks.originatingThreadId,
      status: tasks.status,
    })
    .from(tasks)
    .where(eq(tasks.id, args.taskId))
    .limit(1);
  if (!task) {
    log.warn({ taskId: args.taskId }, "synthesizeForTask: task not found");
    return { ok: false, reason: "task_not_found" };
  }
  if (!task.originatingThreadId) {
    return { ok: false, reason: "task_not_chat_origin" };
  }
  return synthesizeForThread({
    threadId: task.originatingThreadId,
    artifact: { kind: "task", taskId: task.id },
    taskStatusHint:
      task.status === "done" || task.status === "review"
        ? task.status
        : undefined,
  });
}
