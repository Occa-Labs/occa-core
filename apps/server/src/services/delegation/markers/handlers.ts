// Per-token side-effect handlers for `[[OCCA:DELEGATE]]…`,
// `[[OCCA:BLOCK]]…`, `[[OCCA:REPORT]]…` markers. Each handler:
//   - validates the parsed body via the domain zod schema (or raw text
//     in REPORT's case — see handleReportBlock)
//   - performs the side-effect (auto-approve delegation, write blockers,
//     post comment, hand off REPORT to dispatcher for chat-commit)
//   - returns an `ActionBlockOutcome` so the dispatcher can decide the
//     final task status
//
// CLAUDE.md forbids cross-feature imports (features/tasks ↛ features/
// agents). DELEGATE needs `canDeploy` from features/agents — it comes
// in via dependency injection. Task creation + dispatch enqueue live in
// `infra/`, which features ARE allowed to import directly.

import { eq, inArray } from "drizzle-orm";
import type { ContentBlock } from "@occa/shared/types";
import { deployments, tasks } from "@occa/shared/schema";
import type { OccaActionBlock } from "@occa/shared/markers";
import { getTier } from "@occa/shared/role-catalog";
import { db } from "../../../infra/database/client";
import { createTaskRecord } from "../../../infra/database/task-creation";
import { enqueueTaskDispatch } from "../../../infra/queue/task-worker";
import { childLogger } from "../../../lib/logger";
import { LIMITS } from "../../../lib/limits";
import {
  blockBlockPayload,
  delegateBlockPayload,
  type ActionBlockOutcome,
} from "./schemas";
import { createTaskComment } from "../../../features/tasks/services/comments";

const log = childLogger("services:delegation:markers");

// Shape of the canDeploy result. Loose `{ok, reason?}` rather than a
// discriminated union to align with the existing deployment-hierarchy
// implementation. Handlers null-check the reason at error sites.
export interface ScopeCheck {
  ok: boolean;
  reason?: string;
}

// Args for the injected chat-poster. Cross-feature port: the dispatcher
// has no business figuring out which deployment is the CEO or writing
// into `chat_messages` directly. The composition root wires both the
// CEO lookup (features/agents) and the chat-message insert
// (features/chat). The action-block handler no longer calls this —
// it returns a `report_pending` outcome and the dispatcher invokes
// `postCeoChatMessage` only after the bypass-delegation guard passes.
//
// Note `deploymentId` is intentionally absent — the chat thread always
// belongs to the company's CEO, regardless of who emitted REPORT.
export interface PostCeoChatMessageArgs {
  companyId: string;
  content: string;
  traceId: string;
}

// Outcome of `postCeoChatMessage` — the dispatcher emits the right
// audit event based on whether a CEO deployment existed at post time.
export type PostCeoChatMessageOutcome =
  | { ok: true }
  | { ok: false; reason: "no_ceo_deployment" };

export interface ActionBlockDeps {
  // Cross-feature port: validates whether `requesterId` may delegate to
  // `targetId` (i.e. target sits in requester's subtree). Wired in by
  // the composition root from features/agents/services/deployment-
  // hierarchy.canDeploy. Kept as an injected port to respect the no-
  // cross-feature-import layer rule.
  canDeploy: (requesterId: string, targetId: string) => Promise<ScopeCheck>;
}

export interface ActionBlockHandlerArgs {
  block: OccaActionBlock;
  agentId: string; // requesting deployment
  // Persona role of the emitting deployment (e.g. "ceo", "senior_writer").
  // Used by REPORT handler to gate the marker to CEO tier only — non-CEO
  // agents finish their task normally and let the cascade-then-synthesis
  // service post the user-facing reply.
  agentRole: string;
  companyId: string;
  currentTaskId: string;
  // Trace row id of the agent reply that emitted this block. Stamped
  // onto any side-effect that wants an audit link back to the run.
  traceId: string;
}

export async function handleDelegateBlock(
  args: ActionBlockHandlerArgs,
  deps: ActionBlockDeps,
): Promise<ActionBlockOutcome> {
  const parsed = delegateBlockPayload.safeParse(args.block.body);
  if (!parsed.success) {
    log.warn(
      { detail: parsed.error.flatten() },
      "DELEGATE block rejected: invalid payload",
    );
    return { kind: "ignored", reason: "invalid_payload" };
  }
  const dp = parsed.data;

  // Scope check: the target must sit in the requester's subtree.
  // canDeploy is wired in from features/agents via DI to keep this
  // handler free of cross-feature imports.
  const check = await deps.canDeploy(args.agentId, dp.targetAgentId);
  if (!check.ok) {
    log.warn(
      { reason: check.reason },
      "DELEGATE block rejected: scope check failed",
    );
    return {
      kind: "ignored",
      reason: `scope_${check.reason ?? "unknown"}`,
    };
  }

  // Cross-company guard: the target deployment must belong to the same
  // company as the requester. canDeploy already enforces hierarchy but
  // the cheap explicit check keeps the failure mode observable.
  const [target] = await db
    .select({ id: deployments.id, companyId: deployments.companyId })
    .from(deployments)
    .where(eq(deployments.id, dp.targetAgentId))
    .limit(1);
  if (!target || target.companyId !== args.companyId) {
    log.warn(
      {
        taskId: args.currentTaskId,
        targetAgentId: dp.targetAgentId,
      },
      "DELEGATE block rejected: target deployment not in same company",
    );
    return { kind: "ignored", reason: "target_not_in_company" };
  }

  // Auto-approve: create the child task immediately and queue dispatch.
  // No approval row, no human-in-the-loop — within its subtree the
  // emitting agent is the authority. The parent task's dispatcher will
  // park itself in `review` (via `delegationsSpawned` flag) until the
  // child completes and cascade re-wakes the parent.
  const blocks: ContentBlock[] = [
    { type: "paragraph", text: dp.description },
  ];
  const childTask = await createTaskRecord({
    companyId: args.companyId,
    title: dp.title,
    blocks,
    status: "todo",
    priority: "medium",
    taskType: "other",
    effortLevel: "m",
    tags: [],
    dueDate: null,
    assignedDeploymentId: dp.targetAgentId,
    parentTaskId: args.currentTaskId,
    createdByUserId: null,
    createdByDeploymentId: args.agentId,
    acceptanceCriteria: dp.acceptanceCriteria ?? null,
  });
  void enqueueTaskDispatch(childTask.id).catch((err) => {
    log.error(
      { err, childTaskId: childTask.id, parentTaskId: args.currentTaskId },
      "DELEGATE auto-approve: child dispatch enqueue failed",
    );
  });
  return { kind: "delegated", childTaskId: childTask.id };
}

export async function handleBlockBlock(
  args: ActionBlockHandlerArgs,
): Promise<ActionBlockOutcome> {
  const parsed = blockBlockPayload.safeParse(args.block.body);
  if (!parsed.success) {
    log.warn(
      { detail: parsed.error.flatten() },
      "BLOCK block rejected: invalid payload",
    );
    return { kind: "ignored", reason: "invalid_payload" };
  }
  const { blockedByTaskIds, reason } = parsed.data;

  if (blockedByTaskIds.includes(args.currentTaskId)) {
    log.warn("BLOCK block rejected: cannot block on self");
    return { kind: "ignored", reason: "self_blocker" };
  }

  const blockerRows = await db
    .select({ id: tasks.id, companyId: tasks.companyId })
    .from(tasks)
    .where(inArray(tasks.id, blockedByTaskIds));
  const validIds = blockerRows
    .filter((r) => r.companyId === args.companyId)
    .map((r) => r.id);

  if (validIds.length === 0) {
    log.warn("BLOCK block rejected: no valid blocker ids in same company");
    return { kind: "ignored", reason: "no_valid_blockers" };
  }

  if (reason) {
    try {
      await createTaskComment({
        taskId: args.currentTaskId,
        companyId: args.companyId,
        authorAgentId: args.agentId,
        body: `Blocked by ${validIds.length} task(s): ${reason}`,
      });
    } catch (err) {
      log.error({ err }, "BLOCK reason-comment failed");
    }
  }

  return { kind: "blocked", blockerIds: validIds, reason };
}

export async function handleReportBlock(
  args: ActionBlockHandlerArgs,
): Promise<ActionBlockOutcome> {
  // REPORT is the CEO → user surface, period. Non-CEO agents (Heads,
  // specialists, direct-reports) finish their tasks normally and let
  // the cascade-then-synthesis service produce the user-facing reply.
  // Allowing a specialist's REPORT to post would race the synthesis
  // and duplicate the chat message.
  if (getTier(args.agentRole) !== "ceo") {
    log.warn(
      {
        taskId: args.currentTaskId,
        agentId: args.agentId,
        agentRole: args.agentRole,
      },
      "REPORT block rejected: only CEO tier may emit REPORT",
    );
    return { kind: "ignored", reason: "non_ceo_cannot_report" };
  }

  // REPORT body is plain markdown (not JSON). Read the raw text between
  // the open + close tags directly. Empirically LLMs fail JSON escaping
  // on long markdown bodies, so the contract is "whatever you put
  // inside the block IS the chat message".
  const summary = args.block.raw.trim();
  if (summary.length === 0) {
    log.warn(
      { taskId: args.currentTaskId },
      "REPORT block rejected: empty body",
    );
    return { kind: "ignored", reason: "empty_body" };
  }
  if (summary.length > LIMITS.CHAT_MESSAGE) {
    log.warn(
      { taskId: args.currentTaskId, length: summary.length },
      "REPORT block rejected: body exceeds CHAT_MESSAGE limit",
    );
    return { kind: "ignored", reason: "body_too_long" };
  }

  // REPORT is the CEO → user surface. Only root tasks (no parent) wrap
  // a user request from a chat thread; on a delegated subtask the user
  // never sees it, so reject early.
  const [taskRow] = await db
    .select({
      parentTaskId: tasks.parentTaskId,
      assignedDeploymentId: tasks.assignedDeploymentId,
    })
    .from(tasks)
    .where(eq(tasks.id, args.currentTaskId));
  if (!taskRow) {
    log.warn(
      { taskId: args.currentTaskId },
      "REPORT block rejected: task row not found",
    );
    return { kind: "ignored", reason: "task_not_found" };
  }
  if (taskRow.parentTaskId !== null) {
    log.warn(
      { taskId: args.currentTaskId, parentTaskId: taskRow.parentTaskId },
      "REPORT block rejected: not a root task",
    );
    return { kind: "ignored", reason: "not_root_task" };
  }
  if (taskRow.assignedDeploymentId !== args.agentId) {
    log.warn(
      {
        taskId: args.currentTaskId,
        emitter: args.agentId,
        assigned: taskRow.assignedDeploymentId,
      },
      "REPORT block rejected: emitter is not assignee",
    );
    return { kind: "ignored", reason: "emitter_not_assignee" };
  }

  // Validation passed; commit decision deferred to dispatcher (it owns
  // the cross-block bypass-delegation check).
  return { kind: "report_pending", summary };
}
