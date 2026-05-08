// Per-token side-effect handlers for `[[OCCA:DELEGATE]]…`,
// `[[OCCA:BLOCK]]…` markers. Each handler:
//   - validates the parsed body via the domain zod schema
//   - performs the side-effect (insert approval row / write blockers /
//     post comment)
//   - returns an `ActionBlockOutcome` so the dispatcher can decide the
//     final task status
//
// CLAUDE.md forbids cross-feature imports (features/tasks ↛ features/
// agents). DELEGATE needs `canDeploy` from the deployment-hierarchy
// service in features/agents — we accept it via dependency injection
// rather than direct import. The composition root (queue worker that
// invokes the dispatcher) wires the dep.

import { inArray } from "drizzle-orm";
import { approvals, tasks } from "@occa/shared/schema";
import type { OccaActionBlock } from "@occa/shared/markers";
import { db } from "../../../../infra/database/client";
import { childLogger } from "../../../../lib/logger";
import {
  blockBlockPayload,
  delegateBlockPayload,
  type ActionBlockOutcome,
} from "../../domain/action-blocks/schemas";
import { createTaskComment } from "../comments";

const log = childLogger("services:tasks:action-blocks");

// Shape of the canDeploy result. Loose `{ok, reason?}` rather than a
// discriminated union to align with the existing deployment-hierarchy
// implementation. Handlers null-check the reason at error sites.
export interface ScopeCheck {
  ok: boolean;
  reason?: string;
}

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
  companyId: string;
  currentTaskId: string;
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

  await db.insert(approvals).values({
    companyId: args.companyId,
    requestedByDeploymentId: args.agentId,
    actionType: "delegate",
    payload: { ...dp, parentTaskId: args.currentTaskId },
  });
  return { kind: "approval_created" };
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
