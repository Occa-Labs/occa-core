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
import { CEO_ACTIONS } from "../../../services/delegation/markers/registry";
import type { ActionBlockOutcome } from "../../../services/delegation/markers/schemas";

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

  // OS-mutation markers are Auto-tier: CEO emits the marker, the
  // handler applies the mutation immediately, and a short receipt is
  // appended to the assistant reply. Multiple blocks per turn are
  // allowed (one marker = one tuple). Handler dispatch is by token.
  const osMutationReceipts: string[] = [];
  const baseArgs = {
    agentId: ceo.id,
    agentRole: ceo.role,
    companyId: args.companyId,
    currentTaskId: "",
    traceId,
  };
  // Set when a with-approval marker queues an inline-approvable proposal,
  // so the assistant message can render an inline Approve/Reject card. First
  // one wins (one such proposal per turn in practice).
  let linkedApprovalId: string | null = null;
  for (const block of blocks) {
    const action = CEO_ACTIONS[block.token];
    if (!action) continue;
    const outcome: ActionBlockOutcome = await action.run({
      block,
      ...baseArgs,
    });
    const line = formatOsMutationReceipt(outcome);
    if (line) osMutationReceipts.push(line);
    if (
      linkedApprovalId === null &&
      (outcome.kind === "profile_edit_proposed" ||
        outcome.kind === "knowledge_edit_proposed" ||
        outcome.kind === "routine_edit_proposed" ||
        outcome.kind === "skill_library_edit_proposed" ||
        outcome.kind === "tool_edit_proposed" ||
        outcome.kind === "workflow_delete_proposed" ||
        outcome.kind === "task_delete_proposed")
    ) {
      linkedApprovalId = outcome.proposalId;
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
  // Threshold sized to comfortably accommodate legitimate CEO surface-
  // area replies — listing the installable-skill catalog, summarising
  // the team, explaining a routing decision — while still tripping on a
  // genuine deliverable bypass (a tweet thread, a draft, a research
  // brief). Pre-CEO-Runs-OS this was 1200, which collateral-damaged
  // catalog listings; raised to 2500 once status / list questions
  // became a first-class chat use case. Prompt-side brevity rule
  // (render/chat.ts STATUS / LIST REPLIES) keeps most info answers
  // well under this anyway.
  const INLINE_DELIVERABLE_THRESHOLD = 2_500;
  const didCreateTask = createdTask !== null;
  const didMutateOs = osMutationReceipts.length > 0;
  const suppressInlineDeliverable =
    !didCreateTask &&
    !didMutateOs &&
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
    const parts = [cleanReply, ...osMutationReceipts].filter(
      (s) => s.length > 0,
    );
    finalContent = parts.length > 0 ? parts.join("\n\n") : "(empty reply)";
  }

  const assistantMsg = await insertMessage({
    threadId,
    companyId: args.companyId,
    deploymentId: ceo.id,
    role: "assistant",
    content: finalContent,
    createdTaskId: createdTask?.id ?? null,
    linkedApprovalId,
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

// Receipt copy mapped from the Auto-tier OS-mutation handler outcomes
// (INSTALL_SKILL / UNINSTALL_SKILL / BIND_TOOL / UNBIND_TOOL). Empty
// string = no user-visible line (e.g. permission_denied is silent so a
// non-CEO emitter can't probe the surface from chat).
function formatOsMutationReceipt(outcome: ActionBlockOutcome): string {
  switch (outcome.kind) {
    case "skill_installed":
      return outcome.alreadyInstalled
        ? `✓ "${outcome.skillName}" already installed on ${outcome.deploymentName}.`
        : `✓ Installed "${outcome.skillName}" on ${outcome.deploymentName}. Active on next task.`;
    case "skill_uninstalled":
      return outcome.removed
        ? `✓ Uninstalled "${outcome.skillKey}" from ${outcome.deploymentName}. Removed on next task.`
        : `✓ "${outcome.skillKey}" was not installed on ${outcome.deploymentName}.`;
    case "skill_install_rejected":
      switch (outcome.reason) {
        case "skill_not_found":
          return `× Skill "${outcome.skillKey}" not found in catalog.`;
        case "role_not_allowed":
          return `× Skill "${outcome.skillKey}" not allowed for this agent's role.`;
        case "cross_company_skill":
          return `× Skill "${outcome.skillKey}" does not belong to this company.`;
        case "target_retired":
          return `× Target agent is retired.`;
        case "invalid_body":
          return `× INSTALL_SKILL payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "skill_uninstall_rejected":
      switch (outcome.reason) {
        case "target_not_in_company":
          return `× Target agent does not belong to this company.`;
        case "target_retired":
          return `× Target agent is retired.`;
        case "invalid_body":
          return `× UNINSTALL_SKILL payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "tool_bound":
      return outcome.alreadyBound
        ? `✓ "${outcome.toolLabel}" already bound to ${outcome.deploymentName}.`
        : `✓ Bound "${outcome.toolLabel}" to ${outcome.deploymentName}. Available on next task.`;
    case "tool_unbound": {
      const label = outcome.toolLabel ?? outcome.toolId;
      return outcome.removed
        ? `✓ Unbound "${label}" from ${outcome.deploymentName}.`
        : `✓ "${label}" was not bound to ${outcome.deploymentName}.`;
    }
    case "tool_bind_rejected":
      switch (outcome.reason) {
        case "tool_not_found":
          return `× Tool not found in this company's tool list.`;
        case "role_not_allowed":
          return `× Tool not allowed for this agent's role.`;
        case "cross_company_tool":
          return `× Tool does not belong to this company.`;
        case "target_retired":
          return `× Target agent is retired.`;
        case "invalid_body":
          return `× BIND_TOOL payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "tool_unbind_rejected":
      switch (outcome.reason) {
        case "target_not_in_company":
          return `× Target agent does not belong to this company.`;
        case "target_retired":
          return `× Target agent is retired.`;
        case "invalid_body":
          return `× UNBIND_TOOL payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "channel_toggled":
      if (outcome.alreadyAtTarget) {
        return outcome.enabled
          ? `✓ ${outcome.channelType} already enabled.`
          : `✓ ${outcome.channelType} already disabled.`;
      }
      return outcome.enabled
        ? `✓ ${outcome.channelType} enabled.`
        : `✓ ${outcome.channelType} disabled.`;
    case "channel_toggle_rejected":
      switch (outcome.reason) {
        case "channel_not_connected":
          return `× ${outcome.channelType} is not connected. Connect it from the Channels window first.`;
        case "invalid_body":
          return `× TOGGLE_CHANNEL payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "workflow_toggled":
      if (outcome.alreadyAtTarget) {
        return outcome.enabled
          ? `✓ Workflow "${outcome.workflowName}" already enabled.`
          : `✓ Workflow "${outcome.workflowName}" already disabled.`;
      }
      return outcome.enabled
        ? `✓ Workflow "${outcome.workflowName}" enabled.`
        : `✓ Workflow "${outcome.workflowName}" disabled.`;
    case "workflow_toggle_rejected":
      switch (outcome.reason) {
        case "workflow_not_found":
          return `× Workflow "${outcome.workflowYamlId}" not found.`;
        case "invalid_body":
          return `× TOGGLE_WORKFLOW payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "routine_toggled":
      if (outcome.alreadyAtTarget) {
        return outcome.active
          ? `✓ Routine "${outcome.routineTitle}" already active.`
          : `✓ Routine "${outcome.routineTitle}" already paused.`;
      }
      return outcome.active
        ? `✓ Routine "${outcome.routineTitle}" resumed.`
        : `✓ Routine "${outcome.routineTitle}" paused.`;
    case "routine_toggle_rejected":
      switch (outcome.reason) {
        case "routine_not_found":
          return `× Routine not found.`;
        case "routine_archived":
          return `× Routine is archived. Restore it from the Routines window before toggling.`;
        case "invalid_body":
          return `× TOGGLE_ROUTINE payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "routine_dispatched":
      return `✓ Dispatched "${outcome.routineTitle}" — Task #${outcome.taskNumber} is running now.`;
    case "routine_dispatch_rejected":
      switch (outcome.reason) {
        case "routine_not_found":
          return `× Routine not found.`;
        case "routine_not_active":
          return `× Routine is paused or archived. Resume it before dispatching.`;
        case "no_assignee":
          return `× Routine has no assignee — set one in the Routines window first.`;
        case "already_running":
          return `× A manual dispatch of this routine already ran in the last 5 minutes.`;
        case "invalid_body":
          return `× DISPATCH_ROUTINE payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "routine_assigned": {
      const targetLabel = outcome.assigneeName ?? "(none, cleared)";
      if (outcome.alreadyAtTarget) {
        return `✓ Routine "${outcome.routineTitle}" already assigned to ${targetLabel}.`;
      }
      return `✓ Routine "${outcome.routineTitle}" reassigned to ${targetLabel}.`;
    }
    case "routine_assign_rejected":
      switch (outcome.reason) {
        case "routine_not_found":
          return `× Routine not found.`;
        case "assignee_not_in_company":
          return `× Assignee deployment does not belong to this company.`;
        case "assignee_retired":
          return `× Target assignee is retired.`;
        case "invalid_body":
          return `× ASSIGN_ROUTINE payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "deployment_proposed": {
      const named = outcome.suggestedName ? ` "${outcome.suggestedName}"` : "";
      const withSkills =
        outcome.skillCount > 0 ? ` with ${outcome.skillCount} skill(s)` : "";
      return `✓ Queued a proposal to deploy a ${outcome.role} agent${named} on ${outcome.runtime}${withSkills}. Open the Approvals window and hit "Deploy this" — you enter the gateway token and sign there. Nothing is created from chat.`;
    }
    case "deployment_propose_rejected":
      switch (outcome.reason) {
        case "role_not_allowed":
          return `× That role can't be proposed for deployment.`;
        case "role_already_filled":
          return `× That role is already filled — it's one per company.`;
        case "skill_not_found":
          return `× A proposed skill isn't in this company's catalog.`;
        case "runtime_not_registered":
          return `× That runtime isn't registered.`;
        case "invalid_body":
          return `× PROPOSE_DEPLOYMENT payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "profile_edit_proposed":
      return `✓ Queued a profile change (${outcome.fieldCount} field${
        outcome.fieldCount === 1 ? "" : "s"
      }) for your approval. Open the Approvals window to review and apply it. Nothing changes until you approve.`;
    case "profile_edit_propose_rejected":
      switch (outcome.reason) {
        case "invalid_body":
          return `× PROPOSE_PROFILE_EDIT payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "knowledge_edit_proposed": {
      const verb =
        outcome.op === "create"
          ? "add"
          : outcome.op === "delete"
            ? "remove"
            : "update";
      return `✓ Queued a knowledge-file change (${verb} ${outcome.path}) for your approval. Open the Approvals window to review and apply it. Nothing changes until you approve.`;
    }
    case "knowledge_edit_propose_rejected":
      switch (outcome.reason) {
        case "invalid_body":
          return `× PROPOSE_KNOWLEDGE_EDIT payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "routine_edit_proposed":
      return outcome.op === "delete"
        ? `✓ Queued the deletion of a routine for your approval. Open the Approvals window to review and apply it. Nothing changes until you approve.`
        : `✓ Queued a routine change for your approval. Open the Approvals window to review and apply it. Nothing changes until you approve.`;
    case "routine_edit_propose_rejected":
      switch (outcome.reason) {
        case "invalid_body":
          return `× PROPOSE_ROUTINE_EDIT payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "skill_library_edit_proposed":
      return outcome.op === "remove"
        ? `✓ Queued removing a skill from the library for your approval. Open the Approvals window to review and apply it. Nothing changes until you approve.`
        : `✓ Queued a skill allowed-roles change for your approval. Open the Approvals window to review and apply it. Nothing changes until you approve.`;
    case "skill_library_edit_propose_rejected":
      switch (outcome.reason) {
        case "invalid_body":
          return `× PROPOSE_SKILL_LIBRARY_EDIT payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "tool_edit_proposed": {
      const what =
        outcome.op === "delete"
          ? "deleting a tool"
          : outcome.op === "set_status"
            ? "a tool pause/activate"
            : "a tool allowed-roles change";
      return `✓ Queued ${what} for your approval. Open the Approvals window to review and apply it. Nothing changes until you approve.`;
    }
    case "tool_edit_propose_rejected":
      switch (outcome.reason) {
        case "invalid_body":
          return `× PROPOSE_TOOL_EDIT payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "workflow_delete_proposed":
      return `✓ Queued deleting a workflow for your approval. Open the Approvals window to review and apply it. Nothing changes until you approve.`;
    case "workflow_delete_propose_rejected":
      switch (outcome.reason) {
        case "invalid_body":
          return `× PROPOSE_WORKFLOW_DELETE payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "task_delete_proposed":
      return `✓ Queued deleting a task for your approval. Open the Approvals window to review and apply it. Nothing changes until you approve.`;
    case "task_delete_propose_rejected":
      switch (outcome.reason) {
        case "invalid_body":
          return `× PROPOSE_TASK_DELETE payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "task_status_set": {
      const ref = `Task #${outcome.taskNumber}`;
      if (outcome.alreadyAtTarget) {
        return `✓ ${ref} is already in "${outcome.to}".`;
      }
      const billedNote = outcome.billed
        ? ` It's now complete — the company has been billed for it.`
        : "";
      return `✓ Moved ${ref} from "${outcome.from}" to "${outcome.to}".${billedNote}`;
    }
    case "task_status_set_rejected":
      switch (outcome.reason) {
        case "task_not_found":
          return `× Task not found.`;
        case "task_archived":
          return `× That task is archived. Unarchive it from the board before moving it.`;
        case "task_locked":
          return `× That task is being worked on right now — wait for the agent to finish before moving it.`;
        case "invalid_transition":
          return `× That status move isn't allowed. A completed task can't be reopened from chat — rerun it from the board instead.`;
        case "invalid_body":
          return `× SET_TASK_STATUS payload invalid.`;
        case "permission_denied":
          return "";
      }
      return "";
    case "task_commented": {
      const ref = `Task #${outcome.taskNumber}`;
      if (outcome.wokenCount > 0) {
        return `✓ Commented on ${ref} and pinged ${outcome.wokenCount} agent(s) to pick it up.`;
      }
      if (outcome.mentionCount > 0) {
        return `✓ Commented on ${ref}. Mentioned ${outcome.mentionCount} — none is currently on this task, so no one was woken.`;
      }
      return `✓ Commented on ${ref}.`;
    }
    case "task_comment_rejected":
      switch (outcome.reason) {
        case "task_not_found":
          return `× Task not found.`;
        case "task_archived":
          return `× That task is archived. Unarchive it from the board before commenting.`;
        case "invalid_body":
          return `× COMMENT_TASK payload invalid (empty or over the length limit).`;
        case "permission_denied":
          return "";
      }
      return "";
    case "task_edited":
      return `✓ Updated Task #${outcome.taskNumber}: ${outcome.fields.join(", ")}.`;
    case "task_edit_rejected":
      switch (outcome.reason) {
        case "task_not_found":
          return `× Task not found.`;
        case "task_archived":
          return `× That task is archived. Unarchive it from the board before editing.`;
        case "task_locked":
          return `× That task is being worked on right now — wait for the agent to finish before editing it.`;
        case "invalid_body":
          return `× EDIT_TASK payload invalid (no editable fields, or a value out of range).`;
        case "permission_denied":
          return "";
      }
      return "";
    default:
      return "";
  }
}
