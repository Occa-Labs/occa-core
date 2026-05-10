// Core orchestration for the user ↔ CEO conversational surface (Phase
// 2.5 of the hierarchical agent system).
//
// One turn = (1) persist user message → (2) invoke CEO adapter with the
// user content → (3) parse the adapter reply for control markers →
// (4) create a task if the CEO emitted CREATE_TASK with a clean scope →
// (5) strip markers and persist the assistant message → (6) return both.
//
// Design rationale:
//   • Conversation continuity is delegated to the adapter via a stable
//     `sessionKey` (`agent:<externalId>:chat:ceo-<userId>`). The gateway
//     keeps history on its end; we don't flatten message log into the
//     prompt body. Cleaner + cheaper + matches dispatcher / chat.ts
//     conventions.
//   • Adapter access goes through `getAdapter(profile.adapterType)` to
//     respect the agent-agnostic core invariant — the BYORT abstraction
//     is load-bearing per CLAUDE.md / whitepaper §14.1.
//   • We open a `traces` row per turn (invocationSource: "chat") so the
//     existing trace-events SSE infrastructure still works. The chat row
//     stores `traceId` for audit; the trace stores no chat semantics.
//   • CREATE_TASK marker reuses `extractActionBlocks` from the shared
//     markers module — same parser the task system uses — so users can
//     migrate it server-side later without parser fork.

import { eq } from "drizzle-orm";
import { traces } from "@occa/shared/schema";
import { extractActionBlocks, stripOccaMarkers } from "@occa/shared/markers";
import { childLogger } from "../../../lib/logger";
import { db } from "../../../infra/database/client";
import { getAdapter } from "../../../lib/adapter-registry";
import { AGENT_WAIT_TIMEOUT_MS } from "../../../lib/timing";
import { createTaskRecord } from "../../../infra/database/task-creation";
import { findCeoForCompany } from "../../agents/repositories/deployments";
import { findByDeploymentId as findRuntimeProfile } from "../../agents/repositories/agent-runtime-profile";
import {
  earliestMessageId,
  insertMessage,
  type ChatMessageRow,
} from "../repositories/chat-messages";
import {
  buildChatPrompt,
  loadChatPromptContext,
} from "./chat-prompt-builder";

const log = childLogger("services:chat-handler");

export type ChatHandlerResult =
  | {
      kind: "no_ceo";
    }
  | {
      kind: "agent_not_configured" | "agent_not_provisioned";
    }
  | {
      kind: "ok";
      user: ChatMessageRow;
      assistant: ChatMessageRow;
      createdTask: { id: string; taskNumber: number; title: string } | null;
    }
  | {
      kind: "adapter_failed";
      user: ChatMessageRow;
      assistant: ChatMessageRow; // system role with the failure note
    };

export interface SendUserTurnArgs {
  companyId: string;
  userId: string;
  content: string;
}

// CREATE_TASK body shape (free-form JSON inside the marker block):
//   {
//     "title":   "<one-line summary>",
//     "brief":   "<full description, multi-paragraph ok>",
//     "tags":    ["optional"],
//     "priority":"medium" | "high" | "low" (optional)
//   }
interface CreateTaskBody {
  title: string;
  brief: string;
  tags?: string[];
  priority?: string;
}

function readCreateTaskBody(
  body: Record<string, unknown> | null,
): CreateTaskBody | null {
  if (!body) return null;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const brief = typeof body.brief === "string" ? body.brief.trim() : "";
  if (title.length === 0 || brief.length === 0) return null;
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === "string")
    : undefined;
  const priority =
    typeof body.priority === "string" ? body.priority.trim() : undefined;
  return { title, brief, tags, priority };
}

// Per-user-CEO sessionKey with a session-boundary suffix. The suffix is
// the id of the EARLIEST chat message in this thread — stable across
// turns within a session (always the first message of the conversation),
// changes only when the user clears the thread (which deletes all rows,
// so the next first message has a fresh id). The gateway sees a brand-
// new conversation after a clear, so the CEO has no memory of prior
// turns.
function ceoChatSessionKey(
  externalAgentId: string,
  userId: string,
  boundary: string | null,
): string {
  // Fallback "init" suffix is only used on the very first turn of a
  // brand-new (or just-cleared) thread — by the time the user sends a
  // second message, the boundary id exists. The first turn's gateway
  // session is therefore opened under "init" but the same thread will
  // converge to the boundary id by turn 2. Acceptable because the
  // gateway's per-sessionKey context isn't load-bearing yet (we're
  // still establishing identity via the wake prompt).
  const suffix = boundary ? boundary.slice(0, 8) : "init";
  return `agent:${externalAgentId}:chat:ceo-${userId}:${suffix}`;
}

export async function sendUserTurn(
  args: SendUserTurnArgs,
): Promise<ChatHandlerResult> {
  const ceo = await findCeoForCompany(args.companyId);
  if (!ceo) return { kind: "no_ceo" };

  const profile = await findRuntimeProfile(ceo.id);
  if (!profile) return { kind: "agent_not_configured" };
  if (!profile.externalAgentId) return { kind: "agent_not_provisioned" };
  const cfg = (profile.adapterConfig ?? {}) as Record<string, unknown>;

  const adapter = getAdapter(profile.adapterType);
  if (!adapter) {
    log.error(
      { adapterType: profile.adapterType, deploymentId: ceo.id },
      "unknown adapter type for CEO",
    );
    return { kind: "agent_not_configured" };
  }

  // Detect "first turn of this session" BEFORE inserting the user msg —
  // if the thread is empty right now, this is a fresh session (either
  // brand-new or post-clear). First turn gets the heavy preamble; later
  // turns ride on the gateway's preserved per-sessionKey context and
  // send only the raw user content. Saves ~500 tokens per turn after
  // the first.
  const isFirstTurn =
    (await earliestMessageId({
      companyId: args.companyId,
      deploymentId: ceo.id,
    })) === null;

  // Persist the user turn first so the FE has something to render even if
  // the adapter call hangs. The trace + assistant turn follow once we
  // know the gateway's verdict.
  const userMsg = await insertMessage({
    companyId: args.companyId,
    deploymentId: ceo.id,
    role: "user",
    content: args.content,
    createdTaskId: null,
    traceId: null,
  });

  const startedAt = new Date();
  const [traceRow] = await db
    .insert(traces)
    .values({
      companyId: args.companyId,
      deploymentId: ceo.id,
      invocationSource: "chat",
      conversationId: `ceo-chat-${args.userId}`,
      actorType: "user",
      actorId: args.userId,
      status: "running",
      startedAt,
    })
    .returning({ id: traces.id });
  const traceId = traceRow.id;

  // First turn: wrap user content in the full wake-prompt (identity +
  // chat rules + workspace pointer). Subsequent turns: send raw user
  // content — the gateway already has the preamble in its per-sessionKey
  // history. If we can't load the prompt context (DB hiccup), fall back
  // to raw content so the call still goes through.
  let wakePrompt = args.content;
  if (isFirstTurn) {
    const promptCtx = await loadChatPromptContext(ceo.id);
    if (promptCtx) {
      wakePrompt = buildChatPrompt(promptCtx, args.content);
    }
  }
  log.info(
    {
      isFirstTurn,
      promptBytes: wakePrompt.length,
      promptHead: wakePrompt.slice(0, 200),
      ceoId: ceo.id,
    },
    "chat wake-prompt built",
  );

  // Boundary is the earliest message id in the thread (the just-inserted
  // user msg on a fresh thread, or the original first message on later
  // turns). Stable across turns within a session; changes only after a
  // clear (when the thread is wiped and the next user msg becomes the
  // new earliest). This drives the gateway sessionKey suffix so the CEO
  // either keeps context (same boundary) or starts fresh (new boundary).
  const boundary = await earliestMessageId({
    companyId: args.companyId,
    deploymentId: ceo.id,
  });
  const sessionKey = ceoChatSessionKey(
    profile.externalAgentId,
    args.userId,
    boundary,
  );
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
      { error: result.error, reason: result.reason, traceId },
      "CEO chat turn failed at adapter",
    );
    const sysMsg = await insertMessage({
      companyId: args.companyId,
      deploymentId: ceo.id,
      role: "system",
      content: `CEO is unreachable right now (${result.error}). Try again in a moment.`,
      createdTaskId: null,
      traceId,
    });
    return { kind: "adapter_failed", user: userMsg, assistant: sysMsg };
  }

  // Parse markers BEFORE stripping so we can act on a CREATE_TASK body.
  // Today only CREATE_TASK is honored from the chat surface; DELEGATE /
  // BLOCK / REVIEW are task-scoped and intentionally ignored here.
  const blocks = extractActionBlocks(result.reply);
  const createBlock = blocks.find((b) => b.token === "CREATE_TASK" && b.parsed);
  const createBody = readCreateTaskBody(createBlock?.body ?? null);

  let createdTask: ChatHandlerResult extends infer R
    ? R extends { kind: "ok"; createdTask: infer T }
      ? T
      : never
    : never = null;
  if (createBody) {
    const taskRow = await createTaskRecord({
      companyId: args.companyId,
      title: createBody.title,
      blocks: [{ type: "paragraph", text: createBody.brief }],
      status: "todo",
      priority: createBody.priority ?? "medium",
      taskType: "other",
      effortLevel: "m",
      tags: createBody.tags ?? [],
      dueDate: null,
      // Assign back to CEO so the existing dispatch path runs and the
      // CEO's downstream-routing prompt (Phase 3) takes over.
      assignedDeploymentId: ceo.id,
      parentTaskId: null,
      createdByUserId: args.userId,
      createdByDeploymentId: null,
      acceptanceCriteria: null,
    });
    createdTask = {
      id: taskRow.id,
      taskNumber: taskRow.taskNumber,
      title: taskRow.title,
    };
  }

  const cleanReply = stripOccaMarkers(result.reply);
  const assistantMsg = await insertMessage({
    companyId: args.companyId,
    deploymentId: ceo.id,
    role: "assistant",
    content: cleanReply.length > 0 ? cleanReply : "(empty reply)",
    createdTaskId: createdTask?.id ?? null,
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

  return { kind: "ok", user: userMsg, assistant: assistantMsg, createdTask };
}
