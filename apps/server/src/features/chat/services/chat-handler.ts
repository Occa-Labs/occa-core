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
import { deployments, traces } from "@occa/shared/schema";
import { extractActionBlocks, stripOccaMarkers } from "@occa/shared/markers";
import { getTier } from "@occa/shared/role-catalog";
import { adapterErrorMessage } from "../../../lib/adapter-error-messages";
import { childLogger } from "../../../lib/logger";
import { db } from "../../../infra/database/client";
import { getAdapter } from "../../../lib/adapter-registry";
import { AGENT_WAIT_TIMEOUT_MS } from "../../../lib/timing";
import { threadSessionKey } from "../../../lib/session-keys";
import { createTaskRecord } from "../../../infra/database/task-creation";
import { enqueueTaskDispatch } from "../../../infra/queue/task-worker";
import { findCeoForCompany } from "../../agents/repositories/deployments";
import { findByDeploymentId as findRuntimeProfile } from "../../agents/repositories/agent-runtime-profile";
import {
  earliestMessageId,
  insertMessage,
  type ChatMessageRow,
} from "../repositories/chat-messages";
import {
  resolveUserCeoThreadId,
  openAgentDmThread,
} from "../repositories/chat-threads";
import {
  loadContext,
  renderChatPrompt,
  ContextNotFoundError,
} from "../../../services/memory";

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
//     "title":         "<one-line summary>",
//     "brief":         "<full description, multi-paragraph ok>",
//     "tags":          ["optional"],
//     "priority":      "medium" | "high" | "low" (optional)
//     "assignToRole":  "<role key from active team>" (optional)
//   }
// Chat-side markers (parsed from CEO's chat reply, distinct from the
// task-mode markers parsed in services/delegation/markers):
//
//   [[OCCA:DELEGATE]] — CEO has a subordinate that fits; one task is
//   created assigned to that subordinate. CEO is NOT given its own
//   task — the user-facing REPORT happens via the delegation/synthesis
//   callback when the subordinate's task completes.
//
//   [[OCCA:CREATE_TASK]] — CEO has no fitting subordinate; one task
//   is created assigned to the CEO itself. CEO then runs it in
//   task-mode and ships the result via [[OCCA:REPORT]] in that turn.
//
// Both paths stamp `originatingUserId` on the task so cascade knows
// which chat thread the synthesis/report should land on.
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

interface DelegateBody {
  targetAgentId: string;
  title: string;
  description: string;
  acceptanceCriteria?: string;
  tags?: string[];
  priority?: string;
}

function readDelegateBody(
  body: Record<string, unknown> | null,
): DelegateBody | null {
  if (!body) return null;
  const targetAgentId =
    typeof body.targetAgentId === "string" ? body.targetAgentId.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  if (
    targetAgentId.length === 0 ||
    title.length === 0 ||
    description.length === 0
  ) {
    return null;
  }
  const acceptanceCriteria =
    typeof body.acceptanceCriteria === "string"
      ? body.acceptanceCriteria.trim()
      : undefined;
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === "string")
    : undefined;
  const priority =
    typeof body.priority === "string" ? body.priority.trim() : undefined;
  return { targetAgentId, title, description, acceptanceCriteria, tags, priority };
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
  // turns ride on the adapter's preserved per-sessionKey context and
  // send only the raw user content. Saves ~500 tokens per turn after
  // the first.
  const isFirstTurn =
    (await earliestMessageId({
      companyId: args.companyId,
      deploymentId: ceo.id,
    })) === null;

  const { id: threadId, resetGeneration } = await resolveUserCeoThreadId({
    companyId: args.companyId,
    ceoDeploymentId: ceo.id,
  });

  // Persist the user turn first so the FE has something to render even if
  // the adapter call hangs. The trace + assistant turn follow once we
  // know the gateway's verdict.
  const userMsg = await insertMessage({
    threadId,
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

  // Build the wake-prompt via the Context Pipeline. First-turn renders
  // the full preamble (identity + team + gaps + rules); subsequent turns
  // render a lighter team/gap refresh — both flow through the same
  // `loadContext()` so org-chart staleness can't drift between surfaces.
  // Falls back to raw user content if context load fails (DB hiccup).
  let wakePrompt = args.content;
  try {
    const spec = await loadContext({
      deploymentId: ceo.id,
      surface: { kind: "chat", isFirstTurn, userMessage: args.content },
    });
    wakePrompt = renderChatPrompt(spec);
  } catch (err) {
    if (err instanceof ContextNotFoundError) {
      log.warn(
        { ceoId: ceo.id },
        "context load returned no deployment — sending raw content",
      );
    } else {
      log.error({ err, ceoId: ceo.id }, "context load failed");
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

  // One gateway session per thread — shared with synthesis so the CEO's
  // interactive session and any background synthesis reports land in the
  // SAME conversation memory. Reset happens via `deleteAgentSession` on
  // thread clear, not via a key suffix. See `lib/session-keys`.
  const sessionKey = threadSessionKey(
    profile.externalAgentId,
    threadId,
    resetGeneration,
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
      threadId,
      companyId: args.companyId,
      deploymentId: ceo.id,
      role: "system",
      content: adapterErrorMessage({ code: result.error, subject: "Your CEO" }),
      createdTaskId: null,
      traceId,
    });
    return { kind: "adapter_failed", user: userMsg, assistant: sysMsg };
  }

  // Parse markers BEFORE stripping. Chat surface honors two markers,
  // DELEGATE preferred when present (CEO has a subordinate that fits)
  // and CREATE_TASK as the fallback (CEO self-executes). BLOCK / REVIEW
  // / REPORT are task-scoped only and intentionally ignored here.
  const blocks = extractActionBlocks(result.reply);
  const delegateBlock = blocks.find(
    (b) => b.token === "DELEGATE" && b.parsed,
  );
  const createBlock = blocks.find(
    (b) => b.token === "CREATE_TASK" && b.parsed,
  );

  let createdTask: ChatHandlerResult extends infer R
    ? R extends { kind: "ok"; createdTask: infer T }
      ? T
      : never
    : never = null;

  if (delegateBlock) {
    const dp = readDelegateBody(delegateBlock.body);
    if (dp) {
      // Validate target deployment exists in the same company. CEO is
      // top-level with tier=ceo, so canDeploy would always pass — skip
      // the full hierarchy check and just enforce the cross-company
      // boundary directly.
      const [target] = await db
        .select({
          id: deployments.id,
          companyId: deployments.companyId,
          status: deployments.status,
          role: deployments.role,
        })
        .from(deployments)
        .where(eq(deployments.id, dp.targetAgentId))
        .limit(1);
      if (
        !target ||
        target.companyId !== args.companyId ||
        target.status !== "active"
      ) {
        log.warn(
          {
            targetAgentId: dp.targetAgentId,
            companyId: args.companyId,
          },
          "chat DELEGATE ignored: target not in company or not active",
        );
      } else if (target.id === ceo.id) {
        log.warn(
          { ceoId: ceo.id },
          "chat DELEGATE ignored: target is the CEO itself (use CREATE_TASK for self-execute)",
        );
      } else if (getTier(target.role) === "head") {
        // Phase C: non-leaf target → open an agent_dm thread for the
        // Head and post the directive there. No task is created; the
        // Head's worker will pick up the DM thread and emit its own
        // DELEGATE / CREATE_TASK to route the work further down.
        const opened = await openAgentDmThread({
          companyId: args.companyId,
          callerDeploymentId: ceo.id,
          calleeDeploymentId: target.id,
          parentThreadId: threadId,
          directive: {
            title: dp.title,
            body: dp.description,
            acceptanceCriteria: dp.acceptanceCriteria ?? null,
            priority: dp.priority ?? null,
            tags: dp.tags ?? null,
          },
        });
        log.info(
          {
            ceoId: ceo.id,
            calleeDeploymentId: target.id,
            dmThreadId: opened.threadId,
            directiveMessageId: opened.messageId,
          },
          "chat DELEGATE → agent_dm thread opened (non-leaf target)",
        );
        // No `createdTask` to surface in the API response — Phase C
        // hides the routing layer from the board.
      } else {
        // Leaf target (specialist or direct_report): open a caller↔callee
        // dm thread (observability-only, autoDispatch=false) so the
        // delegation is visible in the Chats window, then create the
        // task and point `originatingThreadId` at the new dm thread.
        // Cascade synthesizes the task result into the dm thread (Ren's
        // "done" reply) then recurses up via parentThreadId to the
        // user_ceo thread for the founder-facing response.
        const opened = await openAgentDmThread({
          companyId: args.companyId,
          callerDeploymentId: ceo.id,
          calleeDeploymentId: target.id,
          parentThreadId: threadId,
          directive: {
            title: dp.title,
            body: dp.description,
            acceptanceCriteria: dp.acceptanceCriteria ?? null,
            priority: dp.priority ?? null,
            tags: dp.tags ?? null,
          },
          autoDispatch: false,
        });
        const taskRow = await createTaskRecord({
          companyId: args.companyId,
          title: dp.title,
          blocks: [{ type: "paragraph", text: dp.description }],
          status: "todo",
          priority: dp.priority ?? "medium",
          taskType: "other",
          effortLevel: "m",
          tags: dp.tags ?? [],
          dueDate: null,
          assignedDeploymentId: dp.targetAgentId,
          parentTaskId: null,
          createdByUserId: args.userId,
          createdByDeploymentId: null,
          acceptanceCriteria: dp.acceptanceCriteria ?? null,
          originatingUserId: args.userId,
          originatingThreadId: opened.threadId,
        });
        createdTask = {
          id: taskRow.id,
          taskNumber: taskRow.taskNumber,
          title: taskRow.title,
        };
        enqueueTaskDispatch(taskRow.id).catch((err) =>
          log.error(
            { err, taskId: taskRow.id },
            "enqueueTaskDispatch from chat DELEGATE failed",
          ),
        );
      }
    } else {
      log.warn(
        { ceoId: ceo.id },
        "chat DELEGATE ignored: payload missing required fields",
      );
    }
  } else if (createBlock) {
    const createBody = readCreateTaskBody(createBlock.body);
    if (createBody) {
      // No-subordinate self-execute path. CEO will run this task in
      // task-mode and emit [[OCCA:REPORT]] to ship the result back to
      // the originating user's chat thread when done.
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
        assignedDeploymentId: ceo.id,
        parentTaskId: null,
        createdByUserId: args.userId,
        createdByDeploymentId: null,
        acceptanceCriteria: null,
        originatingUserId: args.userId,
        originatingThreadId: threadId,
      });
      createdTask = {
        id: taskRow.id,
        taskNumber: taskRow.taskNumber,
        title: taskRow.title,
      };
      enqueueTaskDispatch(taskRow.id).catch((err) =>
        log.error(
          { err, taskId: taskRow.id },
          "enqueueTaskDispatch from chat CREATE_TASK failed",
        ),
      );
    }
  }

  const cleanReply = stripOccaMarkers(result.reply);

  // Inline-deliverable suppression guard. Chat-mode CEO replies are
  // meant for clarify / propose / confirm / status — not for shipping
  // the actual artifact. When CEO emits a long body with no marker
  // (no task gets created), we replace the content with a coaching
  // notice so the user can see *why* their request didn't progress.
  // The CEO sees this suppression in next-turn history and (over a
  // few turns of the same session) learns to route via marker.
  //
  // Threshold sized to comfortably accommodate a multi-sentence
  // clarify reply but trip on anything resembling a deliverable
  // (a tweet thread, a draft, a research brief). Pure prose with no
  // marker AND >1200 stripped chars is almost always a bypass.
  const INLINE_DELIVERABLE_THRESHOLD = 1_200;
  const didCreateTask = createdTask !== null;
  const suppressInlineDeliverable =
    !didCreateTask &&
    cleanReply.length > INLINE_DELIVERABLE_THRESHOLD;
  let finalContent: string;
  if (suppressInlineDeliverable) {
    log.warn(
      {
        ceoId: ceo.id,
        traceId,
        replyBytes: cleanReply.length,
      },
      "chat reply suppressed: long body with no marker (inline-deliverable bypass)",
    );
    finalContent = [
      `[Reply suppressed by the runtime.]`,
      ``,
      `Your CEO tried to deliver the artifact directly in chat instead`,
      `of routing it through a task. Chat replies are for clarify /`,
      `propose / confirm only — never for the deliverable itself.`,
      ``,
      `Re-send your request and the CEO will emit a DELEGATE or`,
      `CREATE_TASK marker so the work lives in the task system and the`,
      `synthesized result lands back here on completion.`,
    ].join("\n");
  } else {
    finalContent = cleanReply.length > 0 ? cleanReply : "(empty reply)";
  }

  const assistantMsg = await insertMessage({
    threadId,
    companyId: args.companyId,
    deploymentId: ceo.id,
    role: "assistant",
    content: finalContent,
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
