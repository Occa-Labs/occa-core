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

import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { ContentBlock } from "@occa/shared/types";
import {
  agentIdentities,
  agentRuntimeProfile,
  approvals,
  companies,
  companySkills,
  companyTools,
  deploymentChannels,
  deployments,
  routineRuns,
  routines,
  tasks,
  workflows,
} from "@occa/shared/schema";
import type { OccaActionBlock } from "@occa/shared/markers";
import { CSUITE_ROLES, getTier } from "@occa/shared/role-catalog";
import { db } from "../../../infra/database/client";
import { getAdapter } from "../../../lib/adapter-registry";
import { createTaskRecord } from "../../../infra/database/task-creation";
import { enqueueTaskDispatch } from "../../../infra/queue/task-worker";
import { childLogger } from "../../../lib/logger";
import { LIMITS } from "../../../lib/limits";
import {
  assignRoutineBlockPayload,
  bindToolBlockPayload,
  blockBlockPayload,
  delegateBlockPayload,
  dispatchRoutineBlockPayload,
  installSkillBlockPayload,
  proposeDeploymentBlockPayload,
  proposeProfileEditBlockPayload,
  toggleChannelBlockPayload,
  toggleRoutineBlockPayload,
  toggleWorkflowBlockPayload,
  unbindToolBlockPayload,
  uninstallSkillBlockPayload,
  type ActionBlockOutcome,
  type ChannelToggleRejectReason,
  type DeploymentProposeRejectReason,
  type ProfileEditProposeRejectReason,
  type RoutineAssignRejectReason,
  type RoutineDispatchRejectReason,
  type RoutineToggleRejectReason,
  type SkillInstallRejectReason,
  type SkillUninstallRejectReason,
  type ToolBindRejectReason,
  type ToolUnbindRejectReason,
  type WorkflowToggleRejectReason,
} from "./schemas";
import { createTaskComment } from "../../../features/tasks/services/comments";
import { notifyApprovalCreated } from "../../../features/approvals/services/post-create";
import { upsert as upsertCompanyProfile } from "../../../features/companies/repositories/company-profiles";

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

  // No-loop guard: refuse to re-delegate within the same parent task to
  // a teammate who already shipped a child here. The synthesis-turn
  // prompt warns against this, but agents sometimes treat continuation
  // as a fresh wake and queue another task to the writer instead of
  // moving on (Phase A → Phase B handoff). Catching it server-side
  // closes the loop deterministically — a routine wrapper now executes
  // at most one delegation per subordinate, forcing the orchestrator
  // to either advance to a DIFFERENT teammate or park the cycle.
  const existingChildren = await db
    .select({ assignedDeploymentId: tasks.assignedDeploymentId })
    .from(tasks)
    .where(eq(tasks.parentTaskId, args.currentTaskId));
  const alreadyAssigned = existingChildren.some(
    (c) => c.assignedDeploymentId === dp.targetAgentId,
  );
  if (alreadyAssigned) {
    log.warn(
      {
        parentTaskId: args.currentTaskId,
        targetAgentId: dp.targetAgentId,
      },
      "DELEGATE block rejected: target already has a child under this parent",
    );
    return { kind: "ignored", reason: "target_already_delegated" };
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

// INSTALL_SKILL: append a skill key to a target deployment's
// desired_skills array. CEO-only, idempotent, no chain side-effect (skill
// binding is Ephemeral tier — see ceo-runs-os-design.md). Receipt copy +
// chat-post happens in the dispatcher using fields in the outcome.
export async function handleInstallSkillBlock(
  args: ActionBlockHandlerArgs,
): Promise<ActionBlockOutcome> {
  const reject = (
    reason: SkillInstallRejectReason,
    skillKey: string,
  ): ActionBlockOutcome => ({
    kind: "skill_install_rejected",
    reason,
    skillKey,
  });

  if (getTier(args.agentRole) !== "ceo") {
    log.warn(
      { agentId: args.agentId, agentRole: args.agentRole },
      "INSTALL_SKILL block rejected: only CEO tier may emit INSTALL_SKILL",
    );
    return reject("permission_denied", "");
  }

  const parsed = installSkillBlockPayload.safeParse(args.block.body);
  if (!parsed.success) {
    log.warn(
      { detail: parsed.error.flatten() },
      "INSTALL_SKILL block rejected: invalid payload",
    );
    return reject("invalid_body", "");
  }
  const { deploymentId, skillKey } = parsed.data;

  // Target lookup: join deployments → agent_identities for a human name
  // (used in the chat receipt) + the current desired_skills array from
  // agent_runtime_profile. Single round-trip.
  const [target] = await db
    .select({
      id: deployments.id,
      companyId: deployments.companyId,
      role: deployments.role,
      status: deployments.status,
      name: agentIdentities.name,
      desiredSkills: agentRuntimeProfile.desiredSkills,
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

  if (!target || target.companyId !== args.companyId) {
    log.warn(
      { deploymentId, emitterCompanyId: args.companyId },
      "INSTALL_SKILL block rejected: target not in same company",
    );
    return reject("cross_company_skill", skillKey);
  }
  if (target.status === "retired") {
    return reject("target_retired", skillKey);
  }

  // Skill lookup: must be either built-in (company_id IS NULL) or owned
  // by the emitter's company. Cross-company custom skill = reject.
  const [skill] = await db
    .select({
      key: companySkills.key,
      name: companySkills.name,
      allowedRoles: companySkills.allowedRoles,
      companyId: companySkills.companyId,
    })
    .from(companySkills)
    .where(
      and(
        eq(companySkills.key, skillKey),
        or(
          isNull(companySkills.companyId),
          eq(companySkills.companyId, args.companyId),
        ),
      ),
    )
    .limit(1);

  if (!skill) {
    return reject("skill_not_found", skillKey);
  }

  // Empty allowedRoles = unrestricted. Otherwise the target's role must
  // be in the list.
  if (
    skill.allowedRoles.length > 0 &&
    !skill.allowedRoles.includes(target.role)
  ) {
    log.warn(
      {
        skillKey,
        targetRole: target.role,
        allowedRoles: skill.allowedRoles,
      },
      "INSTALL_SKILL block rejected: target role not in allowedRoles",
    );
    return reject("role_not_allowed", skillKey);
  }

  // Idempotent path: skill already present → no write, receipt still
  // surfaces so CEO knows the state.
  if (target.desiredSkills.includes(skillKey)) {
    return {
      kind: "skill_installed",
      deploymentId: target.id,
      deploymentName: target.name,
      skillKey,
      skillName: skill.name,
      alreadyInstalled: true,
    };
  }

  if (target.desiredSkills.length >= LIMITS.DESIRED_SKILLS_MAX) {
    log.warn(
      {
        deploymentId,
        count: target.desiredSkills.length,
      },
      "INSTALL_SKILL block rejected: desired_skills cap reached",
    );
    return reject("invalid_body", skillKey);
  }

  // Append + mark for re-init at next trace start. Race window with a
  // concurrent emit is negligible in practice (single CEO per company)
  // and the worst case is one extra DB round on a duplicate insert,
  // caught by the array-contains check next turn.
  await db
    .update(agentRuntimeProfile)
    .set({
      desiredSkills: sql`array_append(${agentRuntimeProfile.desiredSkills}, ${skillKey})`,
      skillsInitializedAt: new Date(),
    })
    .where(eq(agentRuntimeProfile.deploymentId, deploymentId));

  log.info(
    {
      ceoDeploymentId: args.agentId,
      targetDeploymentId: deploymentId,
      skillKey,
      traceId: args.traceId,
    },
    "INSTALL_SKILL applied",
  );

  return {
    kind: "skill_installed",
    deploymentId: target.id,
    deploymentName: target.name,
    skillKey,
    skillName: skill.name,
    alreadyInstalled: false,
  };
}

// UNINSTALL_SKILL: inverse of INSTALL_SKILL. Drops the key from the
// target deployment's desired_skills array. Idempotent — when the key
// isn't present we still return success with `removed: false` so the
// receipt becomes a "wasn't installed" ack rather than an error.
// Catalog existence is NOT checked (a dangling skill key in the array
// is exactly the case we want to clean up).
export async function handleUninstallSkillBlock(
  args: ActionBlockHandlerArgs,
): Promise<ActionBlockOutcome> {
  const reject = (
    reason: SkillUninstallRejectReason,
    skillKey: string,
  ): ActionBlockOutcome => ({
    kind: "skill_uninstall_rejected",
    reason,
    skillKey,
  });

  if (getTier(args.agentRole) !== "ceo") {
    log.warn(
      { agentId: args.agentId, agentRole: args.agentRole },
      "UNINSTALL_SKILL block rejected: only CEO tier may emit UNINSTALL_SKILL",
    );
    return reject("permission_denied", "");
  }

  const parsed = uninstallSkillBlockPayload.safeParse(args.block.body);
  if (!parsed.success) {
    log.warn(
      { detail: parsed.error.flatten() },
      "UNINSTALL_SKILL block rejected: invalid payload",
    );
    return reject("invalid_body", "");
  }
  const { deploymentId, skillKey } = parsed.data;

  const [target] = await db
    .select({
      id: deployments.id,
      companyId: deployments.companyId,
      status: deployments.status,
      name: agentIdentities.name,
      desiredSkills: agentRuntimeProfile.desiredSkills,
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

  if (!target || target.companyId !== args.companyId) {
    log.warn(
      { deploymentId, emitterCompanyId: args.companyId },
      "UNINSTALL_SKILL block rejected: target not in same company",
    );
    return reject("target_not_in_company", skillKey);
  }
  if (target.status === "retired") {
    return reject("target_retired", skillKey);
  }

  if (!target.desiredSkills.includes(skillKey)) {
    // Idempotent no-op — return success with removed=false so the
    // receipt clarifies "wasn't installed" without surfacing as an
    // error to the operator.
    return {
      kind: "skill_uninstalled",
      deploymentId: target.id,
      deploymentName: target.name,
      skillKey,
      removed: false,
    };
  }

  await db
    .update(agentRuntimeProfile)
    .set({
      desiredSkills: sql`array_remove(${agentRuntimeProfile.desiredSkills}, ${skillKey})`,
      skillsInitializedAt: new Date(),
    })
    .where(eq(agentRuntimeProfile.deploymentId, deploymentId));

  log.info(
    {
      ceoDeploymentId: args.agentId,
      targetDeploymentId: deploymentId,
      skillKey,
      traceId: args.traceId,
    },
    "UNINSTALL_SKILL applied",
  );

  return {
    kind: "skill_uninstalled",
    deploymentId: target.id,
    deploymentName: target.name,
    skillKey,
    removed: true,
  };
}

// BIND_TOOL: append a tool UUID to a target deployment's enabledTools
// array. Same pattern as INSTALL_SKILL but the catalog lives in
// `company_tools` (per-company only, no built-ins) and the runtime
// stores UUIDs not string keys. Status of the tool (active/paused/
// failed) is NOT a gate here — binding remains valid; invocation-time
// is where paused/failed gets enforced.
export async function handleBindToolBlock(
  args: ActionBlockHandlerArgs,
): Promise<ActionBlockOutcome> {
  const reject = (
    reason: ToolBindRejectReason,
    toolId: string,
  ): ActionBlockOutcome => ({
    kind: "tool_bind_rejected",
    reason,
    toolId,
  });

  if (getTier(args.agentRole) !== "ceo") {
    log.warn(
      { agentId: args.agentId, agentRole: args.agentRole },
      "BIND_TOOL block rejected: only CEO tier may emit BIND_TOOL",
    );
    return reject("permission_denied", "");
  }

  const parsed = bindToolBlockPayload.safeParse(args.block.body);
  if (!parsed.success) {
    log.warn(
      { detail: parsed.error.flatten() },
      "BIND_TOOL block rejected: invalid payload",
    );
    return reject("invalid_body", "");
  }
  const { deploymentId, toolId } = parsed.data;

  const [target] = await db
    .select({
      id: deployments.id,
      companyId: deployments.companyId,
      role: deployments.role,
      status: deployments.status,
      name: agentIdentities.name,
      enabledTools: agentRuntimeProfile.enabledTools,
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

  if (!target || target.companyId !== args.companyId) {
    return reject("cross_company_tool", toolId);
  }
  if (target.status === "retired") {
    return reject("target_retired", toolId);
  }

  const [tool] = await db
    .select({
      id: companyTools.id,
      label: companyTools.label,
      allowedRoles: companyTools.allowedRoles,
      companyId: companyTools.companyId,
    })
    .from(companyTools)
    .where(eq(companyTools.id, toolId))
    .limit(1);

  if (!tool || tool.companyId !== args.companyId) {
    return reject("tool_not_found", toolId);
  }

  if (
    tool.allowedRoles.length > 0 &&
    !tool.allowedRoles.includes(target.role)
  ) {
    log.warn(
      { toolId, targetRole: target.role, allowedRoles: tool.allowedRoles },
      "BIND_TOOL block rejected: target role not in allowedRoles",
    );
    return reject("role_not_allowed", toolId);
  }

  if (target.enabledTools.includes(toolId)) {
    return {
      kind: "tool_bound",
      deploymentId: target.id,
      deploymentName: target.name,
      toolId,
      toolLabel: tool.label,
      alreadyBound: true,
    };
  }

  await db
    .update(agentRuntimeProfile)
    .set({
      enabledTools: sql`array_append(${agentRuntimeProfile.enabledTools}, ${toolId}::uuid)`,
    })
    .where(eq(agentRuntimeProfile.deploymentId, deploymentId));

  log.info(
    {
      ceoDeploymentId: args.agentId,
      targetDeploymentId: deploymentId,
      toolId,
      traceId: args.traceId,
    },
    "BIND_TOOL applied",
  );

  return {
    kind: "tool_bound",
    deploymentId: target.id,
    deploymentName: target.name,
    toolId,
    toolLabel: tool.label,
    alreadyBound: false,
  };
}

// UNBIND_TOOL: inverse — drop tool UUID from enabledTools. Catalog row
// is fetched for the receipt label only; missing row → fall back to id.
export async function handleUnbindToolBlock(
  args: ActionBlockHandlerArgs,
): Promise<ActionBlockOutcome> {
  const reject = (
    reason: ToolUnbindRejectReason,
    toolId: string,
  ): ActionBlockOutcome => ({
    kind: "tool_unbind_rejected",
    reason,
    toolId,
  });

  if (getTier(args.agentRole) !== "ceo") {
    log.warn(
      { agentId: args.agentId, agentRole: args.agentRole },
      "UNBIND_TOOL block rejected: only CEO tier may emit UNBIND_TOOL",
    );
    return reject("permission_denied", "");
  }

  const parsed = unbindToolBlockPayload.safeParse(args.block.body);
  if (!parsed.success) {
    log.warn(
      { detail: parsed.error.flatten() },
      "UNBIND_TOOL block rejected: invalid payload",
    );
    return reject("invalid_body", "");
  }
  const { deploymentId, toolId } = parsed.data;

  const [target] = await db
    .select({
      id: deployments.id,
      companyId: deployments.companyId,
      status: deployments.status,
      name: agentIdentities.name,
      enabledTools: agentRuntimeProfile.enabledTools,
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

  if (!target || target.companyId !== args.companyId) {
    return reject("target_not_in_company", toolId);
  }
  if (target.status === "retired") {
    return reject("target_retired", toolId);
  }

  // Label is for receipt copy only — pull it best-effort.
  const [toolRow] = await db
    .select({ label: companyTools.label, companyId: companyTools.companyId })
    .from(companyTools)
    .where(eq(companyTools.id, toolId))
    .limit(1);
  const toolLabel =
    toolRow && toolRow.companyId === args.companyId ? toolRow.label : null;

  if (!target.enabledTools.includes(toolId)) {
    return {
      kind: "tool_unbound",
      deploymentId: target.id,
      deploymentName: target.name,
      toolId,
      toolLabel,
      removed: false,
    };
  }

  await db
    .update(agentRuntimeProfile)
    .set({
      enabledTools: sql`array_remove(${agentRuntimeProfile.enabledTools}, ${toolId}::uuid)`,
    })
    .where(eq(agentRuntimeProfile.deploymentId, deploymentId));

  log.info(
    {
      ceoDeploymentId: args.agentId,
      targetDeploymentId: deploymentId,
      toolId,
      traceId: args.traceId,
    },
    "UNBIND_TOOL applied",
  );

  return {
    kind: "tool_unbound",
    deploymentId: target.id,
    deploymentName: target.name,
    toolId,
    toolLabel,
    removed: true,
  };
}

// TOGGLE_CHANNEL: flip enabled on a (CEO deployment, channelType) row
// in deployment_channels. Channels are CEO-only by schema design, so
// the lookup always uses the emitter's own deployment id — there is no
// per-target like INSTALL_SKILL. Credentials are never read or written
// by this handler.
export async function handleToggleChannelBlock(
  args: ActionBlockHandlerArgs,
): Promise<ActionBlockOutcome> {
  const reject = (
    reason: ChannelToggleRejectReason,
    channelType: string,
  ): ActionBlockOutcome => ({
    kind: "channel_toggle_rejected",
    reason,
    channelType,
  });

  if (getTier(args.agentRole) !== "ceo") {
    log.warn(
      { agentId: args.agentId, agentRole: args.agentRole },
      "TOGGLE_CHANNEL block rejected: only CEO tier may emit TOGGLE_CHANNEL",
    );
    return reject("permission_denied", "");
  }

  const parsed = toggleChannelBlockPayload.safeParse(args.block.body);
  if (!parsed.success) {
    log.warn(
      { detail: parsed.error.flatten() },
      "TOGGLE_CHANNEL block rejected: invalid payload",
    );
    return reject("invalid_body", "");
  }
  const { channelType, enabled } = parsed.data;

  const [row] = await db
    .select({
      deploymentId: deploymentChannels.deploymentId,
      enabled: deploymentChannels.enabled,
    })
    .from(deploymentChannels)
    .where(
      and(
        eq(deploymentChannels.deploymentId, args.agentId),
        eq(deploymentChannels.channelType, channelType),
      ),
    )
    .limit(1);

  if (!row) {
    return reject("channel_not_connected", channelType);
  }

  const alreadyAtTarget = row.enabled === enabled;
  if (!alreadyAtTarget) {
    await db
      .update(deploymentChannels)
      .set({
        enabled,
        // Mirror the operator save path (channels/sync.ts): status follows
        // the enabled flag. The transport refreshes it with live state once
        // the loop (re)starts.
        status: enabled ? "connected" : "off",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(deploymentChannels.deploymentId, args.agentId),
          eq(deploymentChannels.channelType, channelType),
        ),
      );
  }

  // Reconcile the inbound transport whether or not the DB row changed, so a
  // poll loop that drifted out of sync (e.g. left running by an older code
  // path) is corrected: disabling stops it (no more messages reach the CEO),
  // enabling respawns it. Without this a "disabled" channel can stay
  // functionally on. Telegram is the only channel with a live inbound
  // transport today. Dynamic import avoids a static cycle (orchestrator →
  // chat-handler → this module).
  if (channelType === "telegram") {
    void import("../../../features/channels/transport/telegram-orchestrator")
      .then((m) => m.reloadTelegramChannel(args.agentId))
      .catch((err) =>
        log.error(
          { err, deploymentId: args.agentId },
          "TOGGLE_CHANNEL: telegram transport reload failed",
        ),
      );
  }

  log.info(
    {
      ceoDeploymentId: args.agentId,
      channelType,
      enabled,
      traceId: args.traceId,
    },
    "TOGGLE_CHANNEL applied",
  );

  return {
    kind: "channel_toggled",
    channelType,
    enabled,
    alreadyAtTarget,
  };
}

// TOGGLE_WORKFLOW: flip the enabled flag on a workflow row addressed
// by (companyId, yamlId). YAML text is never touched, so a paused
// workflow can be flipped back on without re-defining it.
export async function handleToggleWorkflowBlock(
  args: ActionBlockHandlerArgs,
): Promise<ActionBlockOutcome> {
  const reject = (
    reason: WorkflowToggleRejectReason,
    workflowYamlId: string,
  ): ActionBlockOutcome => ({
    kind: "workflow_toggle_rejected",
    reason,
    workflowYamlId,
  });

  if (getTier(args.agentRole) !== "ceo") {
    log.warn(
      { agentId: args.agentId, agentRole: args.agentRole },
      "TOGGLE_WORKFLOW block rejected: only CEO tier may emit TOGGLE_WORKFLOW",
    );
    return reject("permission_denied", "");
  }

  const parsed = toggleWorkflowBlockPayload.safeParse(args.block.body);
  if (!parsed.success) {
    log.warn(
      { detail: parsed.error.flatten() },
      "TOGGLE_WORKFLOW block rejected: invalid payload",
    );
    return reject("invalid_body", "");
  }
  const { workflowYamlId, enabled } = parsed.data;

  const [row] = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      enabled: workflows.enabled,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.companyId, args.companyId),
        eq(workflows.yamlId, workflowYamlId),
      ),
    )
    .limit(1);

  if (!row) {
    return reject("workflow_not_found", workflowYamlId);
  }

  if (row.enabled === enabled) {
    return {
      kind: "workflow_toggled",
      workflowYamlId,
      workflowName: row.name,
      enabled,
      alreadyAtTarget: true,
    };
  }

  await db
    .update(workflows)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(workflows.id, row.id));

  log.info(
    {
      ceoDeploymentId: args.agentId,
      workflowId: row.id,
      workflowYamlId,
      enabled,
      traceId: args.traceId,
    },
    "TOGGLE_WORKFLOW applied",
  );

  return {
    kind: "workflow_toggled",
    workflowYamlId,
    workflowName: row.name,
    enabled,
    alreadyAtTarget: false,
  };
}

// TOGGLE_ROUTINE: pause / resume a routine. status is the gate — values
// outside {active, paused} (e.g. an archived routine) are not flippable
// and reject explicitly so CEO doesn't keep re-trying.
export async function handleToggleRoutineBlock(
  args: ActionBlockHandlerArgs,
): Promise<ActionBlockOutcome> {
  const reject = (
    reason: RoutineToggleRejectReason,
    routineId: string,
  ): ActionBlockOutcome => ({
    kind: "routine_toggle_rejected",
    reason,
    routineId,
  });

  if (getTier(args.agentRole) !== "ceo") {
    log.warn(
      { agentId: args.agentId, agentRole: args.agentRole },
      "TOGGLE_ROUTINE block rejected: only CEO tier may emit TOGGLE_ROUTINE",
    );
    return reject("permission_denied", "");
  }

  const parsed = toggleRoutineBlockPayload.safeParse(args.block.body);
  if (!parsed.success) {
    log.warn(
      { detail: parsed.error.flatten() },
      "TOGGLE_ROUTINE block rejected: invalid payload",
    );
    return reject("invalid_body", "");
  }
  const { routineId, active } = parsed.data;

  const [row] = await db
    .select({
      id: routines.id,
      title: routines.title,
      status: routines.status,
    })
    .from(routines)
    .where(
      and(eq(routines.companyId, args.companyId), eq(routines.id, routineId)),
    )
    .limit(1);

  if (!row) {
    return reject("routine_not_found", routineId);
  }

  const desiredStatus = active ? "active" : "paused";

  // Archived / terminal statuses are out of scope for this marker —
  // operator must restore via UI.
  if (row.status !== "active" && row.status !== "paused") {
    return reject("routine_archived", routineId);
  }

  if (row.status === desiredStatus) {
    return {
      kind: "routine_toggled",
      routineId: row.id,
      routineTitle: row.title,
      active,
      alreadyAtTarget: true,
    };
  }

  await db
    .update(routines)
    .set({ status: desiredStatus, updatedAt: new Date() })
    .where(eq(routines.id, row.id));

  log.info(
    {
      ceoDeploymentId: args.agentId,
      routineId: row.id,
      desiredStatus,
      traceId: args.traceId,
    },
    "TOGGLE_ROUTINE applied",
  );

  return {
    kind: "routine_toggled",
    routineId: row.id,
    routineTitle: row.title,
    active,
    alreadyAtTarget: false,
  };
}

// DISPATCH_ROUTINE: fire a routine ONCE now (out-of-band from any
// trigger schedule). Confirm-tier per design — the CEO prompt makes
// it clear the operator must say "go" first; the handler itself
// executes immediately once the marker arrives.
//
// Pattern mirrors the worker scheduler's fireTrigger, minus the
// wakeup() call (worker-resident). We create the wrapper task + queue
// it via enqueueTaskDispatch so the existing task dispatcher hands
// the routine mandate to the assignee through normal task wake.
export async function handleDispatchRoutineBlock(
  args: ActionBlockHandlerArgs,
): Promise<ActionBlockOutcome> {
  const reject = (
    reason: RoutineDispatchRejectReason,
    routineId: string,
  ): ActionBlockOutcome => ({
    kind: "routine_dispatch_rejected",
    reason,
    routineId,
  });

  if (getTier(args.agentRole) !== "ceo") {
    log.warn(
      { agentId: args.agentId, agentRole: args.agentRole },
      "DISPATCH_ROUTINE block rejected: only CEO tier may emit DISPATCH_ROUTINE",
    );
    return reject("permission_denied", "");
  }

  const parsed = dispatchRoutineBlockPayload.safeParse(args.block.body);
  if (!parsed.success) {
    log.warn(
      { detail: parsed.error.flatten() },
      "DISPATCH_ROUTINE block rejected: invalid payload",
    );
    return reject("invalid_body", "");
  }
  const { routineId } = parsed.data;

  const [routine] = await db
    .select({
      id: routines.id,
      companyId: routines.companyId,
      title: routines.title,
      description: routines.description,
      status: routines.status,
      assigneeDeploymentId: routines.assigneeDeploymentId,
    })
    .from(routines)
    .where(
      and(eq(routines.companyId, args.companyId), eq(routines.id, routineId)),
    )
    .limit(1);

  if (!routine) {
    return reject("routine_not_found", routineId);
  }
  if (routine.status !== "active") {
    return reject("routine_not_active", routineId);
  }
  if (!routine.assigneeDeploymentId) {
    return reject("no_assignee", routineId);
  }

  // Idempotency: skip if a manual run has been enqueued in the last
  // five minutes. Cron-triggered runs use a per-second idempotency key
  // tied to the trigger; manual runs lack one (CEO can't compose it
  // safely), so we fall back to a time-window check.
  const recentCutoff = new Date(Date.now() - 5 * 60 * 1000);
  const [recent] = await db
    .select({ id: routineRuns.id })
    .from(routineRuns)
    .where(
      and(
        eq(routineRuns.routineId, routine.id),
        eq(routineRuns.source, "manual"),
        gt(routineRuns.triggeredAt, recentCutoff),
      ),
    )
    .limit(1);
  if (recent) {
    return reject("already_running", routineId);
  }

  const firedAt = new Date();
  const idempotencyKey = `routine:manual:${routine.id}:${firedAt.getTime()}`;

  // Wrapper task creation mirrors apps/worker/src/scheduler.ts
  // fireTrigger so the dispatched routine looks identical to a cron
  // firing from the task system's perspective.
  const wrapperTask = await db.transaction(async (tx) => {
    await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, routine.companyId))
      .for("update");
    const numbered = await tx.execute<{ max: number | null }>(sql`
      SELECT COALESCE(MAX(task_number), 0) AS max
      FROM tasks WHERE company_id = ${routine.companyId}
    `);
    const taskNumber = (numbered.rows[0]?.max ?? 0) + 1;
    const blocks: ContentBlock[] = routine.description
      ? [{ type: "paragraph", text: routine.description }]
      : [];
    const [row] = await tx
      .insert(tasks)
      .values({
        companyId: routine.companyId,
        taskNumber,
        title: routine.title,
        blocks,
        status: "in_progress",
        assignedDeploymentId: routine.assigneeDeploymentId,
        parentTaskId: null,
        taskType: "other",
        tags: ["routine", "manual_dispatch"],
      })
      .returning({ id: tasks.id, taskNumber: tasks.taskNumber });
    return row;
  });

  await db.insert(routineRuns).values({
    routineId: routine.id,
    triggerId: null,
    source: "manual",
    status: "enqueued",
    triggeredAt: firedAt,
    idempotencyKey,
    triggerPayload: {
      dispatchedByCeoDeploymentId: args.agentId,
      wrapperTaskId: wrapperTask.id,
    },
  });

  await db
    .update(routines)
    .set({ lastEnqueuedAt: firedAt, updatedAt: firedAt })
    .where(eq(routines.id, routine.id));

  void enqueueTaskDispatch(wrapperTask.id).catch((err) => {
    log.error(
      { err, wrapperTaskId: wrapperTask.id, routineId: routine.id },
      "DISPATCH_ROUTINE: wrapper task enqueue failed",
    );
  });

  log.info(
    {
      ceoDeploymentId: args.agentId,
      routineId: routine.id,
      wrapperTaskId: wrapperTask.id,
      traceId: args.traceId,
    },
    "DISPATCH_ROUTINE applied",
  );

  return {
    kind: "routine_dispatched",
    routineId: routine.id,
    routineTitle: routine.title,
    taskNumber: wrapperTask.taskNumber,
  };
}

// ASSIGN_ROUTINE: change a routine's standing assignee. In-flight
// wrapper tasks already created are NOT re-routed; next trigger fire
// dispatches to the new assignee. Auto-tier — operator can flip back
// trivially.
export async function handleAssignRoutineBlock(
  args: ActionBlockHandlerArgs,
): Promise<ActionBlockOutcome> {
  const reject = (
    reason: RoutineAssignRejectReason,
    routineId: string,
  ): ActionBlockOutcome => ({
    kind: "routine_assign_rejected",
    reason,
    routineId,
  });

  if (getTier(args.agentRole) !== "ceo") {
    log.warn(
      { agentId: args.agentId, agentRole: args.agentRole },
      "ASSIGN_ROUTINE block rejected: only CEO tier may emit ASSIGN_ROUTINE",
    );
    return reject("permission_denied", "");
  }

  const parsed = assignRoutineBlockPayload.safeParse(args.block.body);
  if (!parsed.success) {
    log.warn(
      { detail: parsed.error.flatten() },
      "ASSIGN_ROUTINE block rejected: invalid payload",
    );
    return reject("invalid_body", "");
  }
  const { routineId, assigneeDeploymentId } = parsed.data;

  const [routine] = await db
    .select({
      id: routines.id,
      title: routines.title,
      assigneeDeploymentId: routines.assigneeDeploymentId,
    })
    .from(routines)
    .where(
      and(eq(routines.companyId, args.companyId), eq(routines.id, routineId)),
    )
    .limit(1);

  if (!routine) {
    return reject("routine_not_found", routineId);
  }

  let assigneeName: string | null = null;
  if (assigneeDeploymentId !== null) {
    const [assignee] = await db
      .select({
        id: deployments.id,
        companyId: deployments.companyId,
        status: deployments.status,
        name: agentIdentities.name,
      })
      .from(deployments)
      .innerJoin(
        agentIdentities,
        eq(deployments.agentIdentityId, agentIdentities.id),
      )
      .where(eq(deployments.id, assigneeDeploymentId))
      .limit(1);
    if (!assignee || assignee.companyId !== args.companyId) {
      return reject("assignee_not_in_company", routineId);
    }
    if (assignee.status === "retired") {
      return reject("assignee_retired", routineId);
    }
    assigneeName = assignee.name;
  }

  if (routine.assigneeDeploymentId === assigneeDeploymentId) {
    return {
      kind: "routine_assigned",
      routineId: routine.id,
      routineTitle: routine.title,
      assigneeName,
      alreadyAtTarget: true,
    };
  }

  await db
    .update(routines)
    .set({ assigneeDeploymentId, updatedAt: new Date() })
    .where(eq(routines.id, routine.id));

  log.info(
    {
      ceoDeploymentId: args.agentId,
      routineId: routine.id,
      newAssigneeDeploymentId: assigneeDeploymentId,
      traceId: args.traceId,
    },
    "ASSIGN_ROUTINE applied",
  );

  return {
    kind: "routine_assigned",
    routineId: routine.id,
    routineTitle: routine.title,
    assigneeName,
    alreadyAtTarget: false,
  };
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

// PROPOSE_DEPLOYMENT: CEO proposes adding an agent. This creates a
// ZERO-AUTHORITY pending proposal (an approvals row) — it does NOT
// deploy. The operator opens the proposal in the OS, supplies the
// gateway endpoint + token, and signs; only that operator-driven action
// provisions the agent. The marker validates every field against an
// operator-curated catalog (role ∈ role catalog, runtime ∈ registered
// adapters, skills ∈ company catalog), so a prompt-injected CEO can at
// worst produce a junk proposal the operator rejects. No credential,
// endpoint, or signature ever rides this marker.
export async function handleProposeDeploymentBlock(
  args: ActionBlockHandlerArgs,
): Promise<ActionBlockOutcome> {
  const reject = (
    reason: DeploymentProposeRejectReason,
  ): ActionBlockOutcome => ({
    kind: "deployment_propose_rejected",
    reason,
  });

  if (getTier(args.agentRole) !== "ceo") {
    log.warn(
      { agentId: args.agentId, agentRole: args.agentRole },
      "PROPOSE_DEPLOYMENT block rejected: only CEO tier may emit PROPOSE_DEPLOYMENT",
    );
    return reject("permission_denied");
  }

  const parsed = proposeDeploymentBlockPayload.safeParse(args.block.body);
  if (!parsed.success) {
    log.warn(
      { detail: parsed.error.flatten() },
      "PROPOSE_DEPLOYMENT block rejected: invalid payload",
    );
    return reject("invalid_body");
  }
  const { role, runtime, skills, suggestedName } = parsed.data;

  // One CEO per company — the CEO cannot propose another CEO. (role
  // already passed the catalog enum; this blocks the top tier specifically.)
  if (getTier(role) === "ceo") {
    log.warn(
      { agentId: args.agentId, role },
      "PROPOSE_DEPLOYMENT block rejected: cannot propose a ceo-tier role",
    );
    return reject("role_not_allowed");
  }

  // Defense in depth: runtime passed the static enum, but assert it is
  // actually registered so the enum and the live registry can't drift.
  if (!getAdapter(runtime)) {
    log.warn(
      { agentId: args.agentId, runtime },
      "PROPOSE_DEPLOYMENT block rejected: runtime not registered",
    );
    return reject("runtime_not_registered");
  }

  // Singleton roles (c-suite + heads) are one-per-company. If a non-
  // retired agent already holds this role, reject the duplicate — the
  // deterministic backstop to the prompt's "don't propose a taken
  // singleton" rule, so a misbehaving CEO still can't queue one.
  const isSingletonRole = CSUITE_ROLES.has(role) || getTier(role) === "head";
  if (isSingletonRole) {
    const [existing] = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.companyId, args.companyId),
          eq(deployments.role, role),
          inArray(deployments.status, ["active", "paused"]),
        ),
      )
      .limit(1);
    if (existing) {
      log.warn(
        { agentId: args.agentId, role },
        "PROPOSE_DEPLOYMENT block rejected: singleton role already filled",
      );
      return reject("role_already_filled");
    }
  }

  // Every proposed skill must exist in the company catalog (built-in or
  // owned by the emitter's company) AND allow the proposed role. Mirrors
  // handleInstallSkillBlock's catalog + role gate, applied per key.
  const uniqueSkills = [...new Set(skills)];
  if (uniqueSkills.length > 0) {
    const rows = await db
      .select({
        key: companySkills.key,
        allowedRoles: companySkills.allowedRoles,
      })
      .from(companySkills)
      .where(
        and(
          inArray(companySkills.key, uniqueSkills),
          or(
            isNull(companySkills.companyId),
            eq(companySkills.companyId, args.companyId),
          ),
        ),
      );
    const allowedByKey = new Map(rows.map((r) => [r.key, r.allowedRoles]));
    for (const key of uniqueSkills) {
      const allowedRoles = allowedByKey.get(key);
      if (!allowedRoles) {
        log.warn(
          { agentId: args.agentId, skillKey: key },
          "PROPOSE_DEPLOYMENT block rejected: skill not in company catalog",
        );
        return reject("skill_not_found");
      }
      if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
        log.warn(
          { agentId: args.agentId, skillKey: key, role, allowedRoles },
          "PROPOSE_DEPLOYMENT block rejected: skill not allowed for proposed role",
        );
        return reject("role_not_allowed");
      }
    }
  }

  const [row] = await db
    .insert(approvals)
    .values({
      companyId: args.companyId,
      requestedByDeploymentId: args.agentId,
      actionType: "propose_deployment",
      payload: {
        role,
        runtime,
        desiredSkills: uniqueSkills,
        suggestedName: suggestedName ?? null,
      },
    })
    .returning();

  // Fire-and-forget operator notification with a deep link into the
  // Approvals window. Degraded (not broken) if it fails — the row is
  // still visible in the window. The operator deploys it from the
  // "Deploy this" handoff (operator-signed); approve alone never deploys.
  void notifyApprovalCreated(row);

  log.info(
    {
      ceoDeploymentId: args.agentId,
      proposalId: row.id,
      role,
      runtime,
      skillCount: uniqueSkills.length,
      traceId: args.traceId,
    },
    "PROPOSE_DEPLOYMENT proposal created",
  );

  return {
    kind: "deployment_proposed",
    proposalId: row.id,
    role,
    runtime,
    skillCount: uniqueSkills.length,
    suggestedName: suggestedName ?? null,
  };
}

// PROPOSE_PROFILE_EDIT (with-approval). The CEO drafts a profile change;
// this creates a zero-authority pending approvals row the operator commits
// in the Approvals window. The marker NEVER writes the profile — the patch
// is applied by applyProfileEditApproval on approve. Unknown keys (payout
// wallet, social handles, founded date) were stripped at the schema, so the
// payload can only carry operator-allowed fields.
export async function handleProposeProfileEditBlock(
  args: ActionBlockHandlerArgs,
): Promise<ActionBlockOutcome> {
  const reject = (
    reason: ProfileEditProposeRejectReason,
  ): ActionBlockOutcome => ({
    kind: "profile_edit_propose_rejected",
    reason,
  });

  if (getTier(args.agentRole) !== "ceo") {
    log.warn(
      { agentId: args.agentId, agentRole: args.agentRole },
      "PROPOSE_PROFILE_EDIT block rejected: only CEO tier may emit it",
    );
    return reject("permission_denied");
  }

  const parsed = proposeProfileEditBlockPayload.safeParse(args.block.body);
  if (!parsed.success) {
    log.warn(
      { detail: parsed.error.flatten() },
      "PROPOSE_PROFILE_EDIT block rejected: invalid payload",
    );
    return reject("invalid_body");
  }
  // parsed.data is the stripped, allowlisted patch — treasuryAddress and
  // other operator-only keys cannot be present here.
  const patch = parsed.data;

  const [row] = await db
    .insert(approvals)
    .values({
      companyId: args.companyId,
      requestedByDeploymentId: args.agentId,
      actionType: "edit_company_profile",
      payload: patch,
    })
    .returning();

  // Fire-and-forget operator notification with a deep link into Approvals.
  // Degraded (not broken) if it fails — the row is still visible there.
  void notifyApprovalCreated(row);

  const fieldCount = Object.keys(patch).length;
  log.info(
    {
      ceoDeploymentId: args.agentId,
      proposalId: row.id,
      fieldCount,
      traceId: args.traceId,
    },
    "PROPOSE_PROFILE_EDIT proposal created",
  );

  return { kind: "profile_edit_proposed", proposalId: row.id, fieldCount };
}

// With-approval side-effect for "edit_company_profile". Re-validates the
// stored payload (defense in depth — re-strips any non-editable key that
// somehow landed in the row) and applies it to the company profile. Wired
// into the approval engine via the registry's executeOnApprove, so approve
// is what actually commits the change.
export async function applyProfileEditApproval(
  approval: typeof approvals.$inferSelect,
): Promise<typeof approvals.$inferSelect> {
  const parsed = proposeProfileEditBlockPayload.safeParse(approval.payload);
  if (!parsed.success) {
    throw new Error("profile_edit_payload_invalid");
  }
  await upsertCompanyProfile({
    companyId: approval.companyId,
    patch: parsed.data,
  });
  return approval;
}
