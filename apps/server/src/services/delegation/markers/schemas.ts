// Per-token zod schemas for the OCCA action-block markers
// `[[OCCA:DELEGATE]] {...} [[/OCCA:DELEGATE]]` etc. Today the parser in
// task-dispatcher.ts validates these inline with ad-hoc string checks;
// centralising into zod gives uniform error reporting and a stable
// payload type per token.

import { z } from "zod";
import { LIMITS } from "../../../lib/limits";

const titleField = z.string().trim().min(1).max(LIMITS.TITLE);
const descriptionField = z.string().trim().min(1).max(LIMITS.DESCRIPTION);
const acceptanceField = z
  .string()
  .trim()
  .max(LIMITS.DESCRIPTION_SHORT)
  .optional();

export const delegateBlockPayload = z.object({
  targetAgentId: z.string().uuid(),
  title: titleField,
  description: descriptionField,
  acceptanceCriteria: acceptanceField,
});

export const blockBlockPayload = z.object({
  blockedByTaskIds: z.array(z.string().uuid()).min(1),
  reason: z.string().trim().max(LIMITS.REASON).optional(),
});

// INSTALL_SKILL: CEO appends a skill key to a target deployment's
// desiredSkills array. companyId is derived from the emitter, not
// declared in the payload, so the marker cannot mutate skills across
// company boundaries.
export const installSkillBlockPayload = z.object({
  deploymentId: z.string().uuid(),
  skillKey: z.string().trim().min(1).max(LIMITS.KEY),
});

// UNINSTALL_SKILL: inverse of INSTALL_SKILL. Same payload shape so the
// CEO can re-emit the same key/deployment pair to undo. Idempotent
// when the skill isn't present.
export const uninstallSkillBlockPayload = installSkillBlockPayload;

// BIND_TOOL: CEO appends a tool UUID to a target deployment's
// enabledTools array. Tools are per-company only (no built-ins) so
// boundary is purely "does this UUID belong to the emitter's company".
export const bindToolBlockPayload = z.object({
  deploymentId: z.string().uuid(),
  toolId: z.string().uuid(),
});

// UNBIND_TOOL: inverse — drop the UUID from enabledTools. Same shape.
export const unbindToolBlockPayload = bindToolBlockPayload;

// TOGGLE_CHANNEL: flip the enabled flag on a (CEO deployment, channel
// type) row. channelType is free text — Channels v1 enumerates 13
// types in deployment_channels.channel_type; we don't enum-validate at
// the marker layer because the row lookup itself enforces existence.
// Credentials are NEVER set via this marker.
export const toggleChannelBlockPayload = z.object({
  channelType: z.string().trim().min(1).max(LIMITS.TINY),
  enabled: z.boolean(),
});

// TOGGLE_WORKFLOW: flip the enabled flag on a workflow row, addressed
// by its stable yaml_id (unique per company). YAML text is never
// touched — only the runtime enable/disable switch.
export const toggleWorkflowBlockPayload = z.object({
  workflowYamlId: z.string().trim().min(1).max(LIMITS.KEY),
  enabled: z.boolean(),
});

// TOGGLE_ROUTINE: flip routines.status between "active" and "paused"
// for the supplied routine UUID. Routines lack a stable slug so the
// marker addresses by id; CEO copies it from COMPANY ROUTINES in the
// prompt. Triggers (cron/webhook) on the routine are not touched —
// pausing the routine itself short-circuits trigger firing.
export const toggleRoutineBlockPayload = z.object({
  routineId: z.string().uuid(),
  active: z.boolean(),
});

// DISPATCH_ROUTINE: fire a routine ONCE now (out-of-band from any
// trigger schedule). Wrapper task is created and queued like a normal
// cron firing would do, but `source` on the resulting routine_runs row
// is "manual". CEO is expected to follow CONFIRM + EMIT flow before
// emitting — production impact, Confirm tier.
export const dispatchRoutineBlockPayload = z.object({
  routineId: z.string().uuid(),
});

// ASSIGN_ROUTINE: change the standing assignee for a routine. Future
// firings (cron + manual) will land on the new assignee. In-flight
// wrapper tasks already dispatched stay with their current assignee —
// re-routing happens at next trigger fire.
export const assignRoutineBlockPayload = z.object({
  routineId: z.string().uuid(),
  // null clears the assignee (routine effectively pauses since
  // fireTrigger short-circuits on no_assignee).
  assigneeDeploymentId: z.string().uuid().nullable(),
});

// REPORT marker is intentionally schema-less: its body is plain
// markdown (not JSON) so the LLM can ship long-form summaries without
// fighting JSON escape rules. The handler reads the raw text between
// the open + close tags and validates length only. See
// `./handlers.ts` handleReportBlock.

// ASK marker is intentionally absent — agents route clarification
// questions through RequestInfo (HTTP back-channel) which posts a
// comment AND pauses the task so it lands in `review`.

export type DelegateBlockPayload = z.infer<typeof delegateBlockPayload>;
export type BlockBlockPayload = z.infer<typeof blockBlockPayload>;
export type InstallSkillBlockPayload = z.infer<typeof installSkillBlockPayload>;
export type UninstallSkillBlockPayload = z.infer<
  typeof uninstallSkillBlockPayload
>;

// Why each reject reason exists — see ceo-runs-os-design.md
// "Failure modes" table. Receipt copy is mapped from this enum in the
// dispatcher.
export type SkillInstallRejectReason =
  | "skill_not_found"
  | "role_not_allowed"
  | "cross_company_skill"
  | "target_retired"
  | "permission_denied"
  | "invalid_body";

// UNINSTALL is permissive on skill identity — even if the catalog row
// is gone, we still want to drop the dangling key. So the reject set
// is smaller: only the membership / authority checks.
export type SkillUninstallRejectReason =
  | "target_retired"
  | "target_not_in_company"
  | "permission_denied"
  | "invalid_body";

export type BindToolBlockPayload = z.infer<typeof bindToolBlockPayload>;
export type UnbindToolBlockPayload = z.infer<typeof unbindToolBlockPayload>;

export type ToolBindRejectReason =
  | "tool_not_found"
  | "role_not_allowed"
  | "cross_company_tool"
  | "target_retired"
  | "permission_denied"
  | "invalid_body";

// UNBIND is permissive same as UNINSTALL_SKILL — dangling tool UUIDs
// on the array should be cleanable even if the catalog row was deleted.
export type ToolUnbindRejectReason =
  | "target_retired"
  | "target_not_in_company"
  | "permission_denied"
  | "invalid_body";

export type ToggleChannelBlockPayload = z.infer<
  typeof toggleChannelBlockPayload
>;

export type ChannelToggleRejectReason =
  | "channel_not_connected"
  | "permission_denied"
  | "invalid_body";

export type ToggleWorkflowBlockPayload = z.infer<
  typeof toggleWorkflowBlockPayload
>;

export type WorkflowToggleRejectReason =
  | "workflow_not_found"
  | "permission_denied"
  | "invalid_body";

export type ToggleRoutineBlockPayload = z.infer<
  typeof toggleRoutineBlockPayload
>;

export type RoutineToggleRejectReason =
  | "routine_not_found"
  | "routine_archived"
  | "permission_denied"
  | "invalid_body";

export type DispatchRoutineBlockPayload = z.infer<
  typeof dispatchRoutineBlockPayload
>;

export type RoutineDispatchRejectReason =
  | "routine_not_found"
  | "routine_not_active"
  | "no_assignee"
  | "already_running"
  | "permission_denied"
  | "invalid_body";

export type AssignRoutineBlockPayload = z.infer<
  typeof assignRoutineBlockPayload
>;

export type RoutineAssignRejectReason =
  | "routine_not_found"
  | "assignee_not_in_company"
  | "assignee_retired"
  | "permission_denied"
  | "invalid_body";

export type ActionBlockOutcome =
  | { kind: "ignored"; reason: string }
  // DELEGATE auto-approved: child task already created + dispatched.
  // Pre-Phase-A this was `approval_created` (inserted a pending row
  // requiring a human click). With the hierarchical algorithm now
  // enforced server-side (see `../policy.ts`), there's no reason to
  // gate CEO→subordinate handoffs on a human — the agent is the
  // authority for its own subtree.
  | { kind: "delegated"; childTaskId: string }
  | { kind: "blocked"; blockerIds: string[]; reason?: string }
  // REPORT validation passed in the handler (body + root + emitter) but
  // the actual chat-insert is deferred to the dispatcher so it can apply
  // the bypass-delegation guard with full visibility into sibling
  // outcomes (DELEGATE emitted? completed children present?). The
  // dispatcher converts this into either an inserted chat message or
  // a rejected REPORT, and emits the final audit event.
  | { kind: "report_pending"; summary: string }
  // INSTALL_SKILL success: append already committed; dispatcher posts
  // chat receipt with deploymentName + skillKey. `alreadyInstalled` is
  // the idempotent path (no write happened but receipt still shows).
  | {
      kind: "skill_installed";
      deploymentId: string;
      deploymentName: string;
      skillKey: string;
      skillName: string;
      alreadyInstalled: boolean;
    }
  | { kind: "skill_install_rejected"; reason: SkillInstallRejectReason; skillKey: string }
  // UNINSTALL_SKILL: removed flag false means the key wasn't in the
  // desired_skills array — the receipt becomes a "wasn't installed"
  // ack rather than a full undo confirmation.
  | {
      kind: "skill_uninstalled";
      deploymentId: string;
      deploymentName: string;
      skillKey: string;
      removed: boolean;
    }
  | { kind: "skill_uninstall_rejected"; reason: SkillUninstallRejectReason; skillKey: string }
  // BIND_TOOL: success carries toolLabel for the receipt copy.
  // alreadyBound = idempotent no-op (key already in enabledTools).
  | {
      kind: "tool_bound";
      deploymentId: string;
      deploymentName: string;
      toolId: string;
      toolLabel: string;
      alreadyBound: boolean;
    }
  | { kind: "tool_bind_rejected"; reason: ToolBindRejectReason; toolId: string }
  | {
      kind: "tool_unbound";
      deploymentId: string;
      deploymentName: string;
      toolId: string;
      // toolLabel resolves from catalog when possible; falls back to
      // toolId when the row no longer exists (dangling cleanup case).
      toolLabel: string | null;
      removed: boolean;
    }
  | { kind: "tool_unbind_rejected"; reason: ToolUnbindRejectReason; toolId: string }
  // TOGGLE_CHANNEL: alreadyAtTarget = idempotent no-op (enabled was
  // already the requested value).
  | {
      kind: "channel_toggled";
      channelType: string;
      enabled: boolean;
      alreadyAtTarget: boolean;
    }
  | {
      kind: "channel_toggle_rejected";
      reason: ChannelToggleRejectReason;
      channelType: string;
    }
  | {
      kind: "workflow_toggled";
      workflowYamlId: string;
      workflowName: string;
      enabled: boolean;
      alreadyAtTarget: boolean;
    }
  | {
      kind: "workflow_toggle_rejected";
      reason: WorkflowToggleRejectReason;
      workflowYamlId: string;
    }
  | {
      kind: "routine_toggled";
      routineId: string;
      routineTitle: string;
      active: boolean;
      alreadyAtTarget: boolean;
    }
  | {
      kind: "routine_toggle_rejected";
      reason: RoutineToggleRejectReason;
      routineId: string;
    }
  | {
      kind: "routine_dispatched";
      routineId: string;
      routineTitle: string;
      // Surface the wrapper task number so CEO can reference it in the
      // receipt prose ("Task #42 is now running").
      taskNumber: number;
    }
  | {
      kind: "routine_dispatch_rejected";
      reason: RoutineDispatchRejectReason;
      routineId: string;
    }
  | {
      kind: "routine_assigned";
      routineId: string;
      routineTitle: string;
      // null = cleared (routine effectively paused)
      assigneeName: string | null;
      alreadyAtTarget: boolean;
    }
  | {
      kind: "routine_assign_rejected";
      reason: RoutineAssignRejectReason;
      routineId: string;
    };
