// Per-token zod schemas for the OCCA action-block markers
// `[[OCCA:DELEGATE]] {...} [[/OCCA:DELEGATE]]` etc. Today the parser in
// task-dispatcher.ts validates these inline with ad-hoc string checks;
// centralising into zod gives uniform error reporting and a stable
// payload type per token.

import { z } from "zod";
import {
  ADAPTER_TYPES,
  EFFORT_LEVELS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type TaskStatus,
} from "@occa/shared/types";
import { ROLE_ORDER } from "@occa/shared/role-catalog";
import { LIMITS } from "../../../lib/limits";
import { roleSchema } from "../../../lib/role-schema";
import {
  createBrainFileBody,
  updateBrainFileBody,
} from "../../../features/company-brain/domain/schemas";

// Cap on an allowed-roles whitelist (library skills + tools share the same
// role-gate semantics). Mirrors the skills feature's MAX_ALLOWED_ROLES.
const ROLE_WHITELIST_MAX = 32;

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

// PROPOSE_DEPLOYMENT: CEO proposes adding an agent to the company. The
// marker does NOT deploy — it creates a zero-authority pending proposal
// (an approvals row) the operator must open in the OS, where they
// supply the gateway endpoint + token and sign. So the payload carries
// ONLY operator-curated catalog selections: a role from the role
// catalog, a runtime from the registered adapters, and skill keys from
// the company catalog. No endpoint, no credential, no signature ever
// rides this marker. companyId is derived from the emitter.
export const proposeDeploymentBlockPayload = z.object({
  role: z.enum(ROLE_ORDER),
  runtime: z.enum(ADAPTER_TYPES),
  skills: z
    .array(z.string().trim().min(1).max(LIMITS.KEY))
    .max(LIMITS.DESIRED_SKILLS_MAX)
    .default([]),
  suggestedName: z.string().trim().min(1).max(LIMITS.NAME).optional(),
});

// PROPOSE_PROFILE_EDIT: CEO drafts changes to the company profile (brand,
// voice, mission, output, contact, presence, chains). With-approval tier:
// the marker does NOT write — its handler creates a pending approvals row
// the operator commits. The payout wallet (treasuryAddress), socialHandles,
// and foundedAt are intentionally ABSENT from this schema; unknown keys are
// stripped (zod default), so the CEO can never get a wallet change into the
// payload, even by mistake. companyId is derived from the emitter.
//
// Max items in a profile list field (content pillars, USPs, etc.) — a sanity
// cap on the marker; the DB columns themselves are unbounded text arrays.
// Kept generous because forbiddenWords is legitimately a long anti-slop /
// anti-hype banned list (50+ terms is normal), not a short tag list.
const PROFILE_LIST_MAX = 100;
const profileText = z.string().trim().max(LIMITS.DESCRIPTION);
const profileShort = z.string().trim().max(LIMITS.TITLE);
const profileList = z
  .array(z.string().trim().min(1).max(LIMITS.DESCRIPTION_SHORT))
  .max(PROFILE_LIST_MAX);

export const proposeProfileEditBlockPayload = z
  .object({
    tagline: profileShort.optional(),
    logoUrl: profileText.optional(),
    niche: profileShort.optional(),
    coverageScope: profileText.optional(),
    coverageExcluded: profileText.optional(),
    contentPillars: profileList.optional(),
    brandVoice: profileText.optional(),
    forbiddenWords: profileList.optional(),
    mission: profileText.optional(),
    vision: profileText.optional(),
    targetAudience: profileText.optional(),
    usps: profileList.optional(),
    coreOffering: profileText.optional(),
    serviceCatalog: profileList.optional(),
    contactEmail: profileShort.optional(),
    salesEmail: profileShort.optional(),
    phone: profileShort.optional(),
    websiteUrl: profileText.optional(),
    blogUrl: profileText.optional(),
    newsletterUrl: profileText.optional(),
    docsUrl: profileText.optional(),
    chainsCovered: profileList.optional(),
  })
  .refine((o) => Object.keys(o).length > 0, {
    message: "at least one profile field required",
  });

// PROPOSE_KNOWLEDGE_EDIT: CEO drafts a create/update/delete of a Company
// Brain knowledge file. With-approval tier: the marker NEVER writes — its
// handler creates a pending approvals row the operator commits, and
// applyKnowledgeEditApproval performs the repo write on approve. Files are
// addressed by `path` (e.g. /brain/glossary.md), not by uuid, since the CEO
// knows them by name. Reuses the canonical Company Brain validators (path
// regex, content/visibility limits) so the marker stays in lockstep with the
// brain feature. Discriminated by `op`; per-member refinement is done in the
// handler (zod discriminatedUnion members must be plain objects).
const knowledgePath = createBrainFileBody.shape.path;
export const proposeKnowledgeEditBlockPayload = z.discriminatedUnion("op", [
  createBrainFileBody.extend({ op: z.literal("create") }),
  updateBrainFileBody.extend({
    op: z.literal("update"),
    path: knowledgePath,
  }),
  z.object({ op: z.literal("delete"), path: knowledgePath }),
]);

// PROPOSE_ROUTINE_EDIT: CEO drafts an edit-mandate or delete of an existing
// routine. With-approval tier; the marker NEVER writes (applyRoutineEditApproval
// runs the repo write on approve). Routines are addressed by routineId (uuid,
// copied from COMPANY ROUTINES in the prompt) since they lack a stable slug —
// consistent with TOGGLE/DISPATCH/ASSIGN_ROUTINE. This action covers ONLY the
// mandate fields (title/description/priority) + delete; status (pause/resume),
// assignee (reassign), and run-now are autonomous markers already, and routine
// CREATE + trigger/schedule editing (cron) are a separate later action.
const routineId = z.string().uuid();
export const proposeRoutineEditBlockPayload = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("update"),
    routineId,
    title: z.string().trim().min(1).max(LIMITS.KEY).optional(),
    description: z.string().max(LIMITS.DESCRIPTION_LONG).optional(),
    priority: z.string().max(LIMITS.TINY).optional(),
  }),
  z.object({ op: z.literal("delete"), routineId }),
]);

// PROPOSE_SKILL_LIBRARY_EDIT: CEO drafts a change to the company skill
// library — import a new GitHub-sourced skill, set a skill's allowed-roles
// whitelist, or remove it from the library entirely. With-approval tier; the
// marker NEVER writes (the repo write runs on approve). Addressed by skillKey
// (canonical owner/repo/slug), consistent with INSTALL_SKILL. set_roles /
// remove target ONLY company-imported skills: platform built-ins (companyId
// IS NULL) are not company-scoped, so the apply lookup never resolves them —
// they cannot be edited or removed here. Importing is the one op where the
// skill does not exist yet: the operator's approval IS the supply-chain gate
// (skill markdown lands in agent prompts), so it is with-approval, never
// autonomous. Installing/uninstalling a skill ONTO an agent stays autonomous.
const skillKeyField = z.string().trim().min(1).max(LIMITS.KEY);
export const proposeSkillLibraryEditBlockPayload = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_roles"),
    skillKey: skillKeyField,
    // Empty array = unrestricted (every role may bind it). Non-empty = the
    // whitelist of roles allowed to bind this skill.
    allowedRoles: z.array(roleSchema).max(ROLE_WHITELIST_MAX),
  }),
  z.object({ op: z.literal("remove"), skillKey: skillKeyField }),
  z.object({
    op: z.literal("import"),
    // Canonical GitHub key (owner/repo/slug) — the same form the catalog and
    // INSTALL_SKILL use. On approve the platform fetches the skill from
    // GitHub and upserts it into the company library.
    skillKey: skillKeyField.regex(
      /^[^\s/]+\/[^\s/]+\/[^\s/]+$/,
      "skillKey must be owner/repo/slug",
    ),
    // Optional initial whitelist. Omitted or empty = unrestricted.
    allowedRoles: z.array(roleSchema).max(ROLE_WHITELIST_MAX).optional(),
  }),
]);

// PROPOSE_TOOL_EDIT: CEO drafts a change to a company tool — set its
// allowed-roles whitelist, or delete it. With-approval; the marker NEVER
// writes (repo write runs on approve). Addressed by toolId (uuid, copied
// from the CEO's context), consistent with BIND_TOOL. Tool CONFIG and
// CREDENTIALS are intentionally absent — editing config is a later action
// and credentials are operator-only (entered/rotated in the OS). Binding a
// tool onto an agent stays autonomous.
const toolId = z.string().uuid();
export const proposeToolEditBlockPayload = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_roles"),
    toolId,
    allowedRoles: z.array(roleSchema).max(ROLE_WHITELIST_MAX),
  }),
  // pause/activate. Only the operator-meaningful states — "failed" is
  // system-set on invocation error, never proposable.
  z.object({
    op: z.literal("set_status"),
    toolId,
    status: z.enum(["active", "paused"]),
  }),
  z.object({ op: z.literal("delete"), toolId }),
]);

// PROPOSE_WORKFLOW_DELETE: CEO drafts deletion of a workflow, addressed by its
// stable yamlId (consistent with TOGGLE_WORKFLOW). With-approval; the marker
// NEVER writes. Workflow CREATE / step-editing is YAML-authoring — a separate
// later action; enable/disable stays autonomous. Delete-only here, so the
// payload is flat (no op discriminator).
export const proposeWorkflowDeleteBlockPayload = z.object({
  workflowYamlId: z.string().trim().min(1).max(LIMITS.KEY),
});

// COMMENT_TASK: CEO posts a comment on a task. Autonomous — runs
// immediately. Body may carry `@Name` mentions; an mentioned agent who is
// assigned to this task is re-woken to pick it up (createTaskComment +
// wakeAgentForComment). Body validation mirrors the comment route
// (commentBody): trimmed, non-empty, capped at DESCRIPTION.
export const commentTaskBlockPayload = z.object({
  taskId: z.string().uuid(),
  body: z.string().trim().min(1).max(LIMITS.DESCRIPTION),
});

// EDIT_TASK: CEO patches a task's metadata (autonomous). Mirrors the
// editable surface of the task PATCH route's updateTaskBody, minus status
// (use SET_TASK_STATUS), assignment (reassign is disabled), and the
// content blocks (description body is not edited from chat). Adds
// acceptanceCriteria. At least one editable field is required. A
// nullable dueDate/acceptanceCriteria lets the CEO clear it.
export const editTaskBlockPayload = z
  .object({
    taskId: z.string().uuid(),
    title: z.string().trim().min(1).max(LIMITS.TITLE).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    taskType: z.enum(TASK_TYPES).optional(),
    effortLevel: z.enum(EFFORT_LEVELS).optional(),
    tags: z
      .array(z.string().trim().min(1).max(LIMITS.TAG))
      .max(LIMITS.TAGS_MAX)
      .optional(),
    dueDate: z.string().datetime().nullable().optional(),
    acceptanceCriteria: z
      .string()
      .trim()
      .max(LIMITS.DESCRIPTION_SHORT)
      .nullable()
      .optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.priority !== undefined ||
      v.taskType !== undefined ||
      v.effortLevel !== undefined ||
      v.tags !== undefined ||
      v.dueDate !== undefined ||
      v.acceptanceCriteria !== undefined,
    { message: "at least one field to edit is required" },
  );

// PROPOSE_TASK_DELETE: CEO drafts deletion of a task by id. With-approval (the
// only with-approval task action — create/edit/status/comment/archive are
// autonomous). The marker NEVER writes; approve runs the delete.
export const proposeTaskDeleteBlockPayload = z.object({
  taskId: z.string().uuid(),
});

// SET_TASK_STATUS: CEO moves a task between kanban columns. Autonomous —
// runs immediately, no approval. Respects the SAME user FSM gate the
// task-detail dropdown obeys (isUserStatusTransitionAllowed); `done` is
// terminal because completing a task bills the company
// (ensureInvoiceForCompletedTask), so it can never be walked back from chat.
export const setTaskStatusBlockPayload = z.object({
  taskId: z.string().uuid(),
  status: z.enum(TASK_STATUSES),
});

// SET_RESULT_URL — the assignee reports the published URL of its own
// deliverable (after posting via a tool). No taskId: it always targets the
// task the agent is currently working on. The URL is anchored on-chain as
// the trace's result_uri when the task completes.
export const setResultUrlBlockPayload = z.object({
  resultUri: z.string().trim().url().max(LIMITS.URL),
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

export type ProposeDeploymentBlockPayload = z.infer<
  typeof proposeDeploymentBlockPayload
>;

// role_not_allowed = catalog role that can't be proposed (the ceo tier
// — one CEO per company) or a skill the proposed role isn't allowed.
// runtime_not_registered = enum passed but the live registry lacks it
// (drift guard). skill_not_found = a key absent from the company
// catalog. role/runtime out-of-catalog values fail the schema enum and
// surface as invalid_body.
export type DeploymentProposeRejectReason =
  | "role_not_allowed"
  | "role_already_filled"
  | "skill_not_found"
  | "runtime_not_registered"
  | "permission_denied"
  | "invalid_body";

export type ProposeProfileEditBlockPayload = z.infer<
  typeof proposeProfileEditBlockPayload
>;

// invalid_body also covers the refine failure (no editable field after
// unknown-key stripping) and any stray non-editable key's type mismatch.
export type ProfileEditProposeRejectReason =
  | "permission_denied"
  | "invalid_body";

export type ProposeKnowledgeEditBlockPayload = z.infer<
  typeof proposeKnowledgeEditBlockPayload
>;

// invalid_body covers a malformed payload AND an "update" op that names no
// field to change (content/visibility both absent — handler-level check, not
// expressible inside a discriminatedUnion member). Path-not-found and
// path-conflict are APPLY-time failures (surfaced via the approval's
// failureReason on approve), not propose-time rejects.
export type KnowledgeEditProposeRejectReason =
  | "permission_denied"
  | "invalid_body";

export type ProposeRoutineEditBlockPayload = z.infer<
  typeof proposeRoutineEditBlockPayload
>;

// invalid_body also covers an "update" op naming no field to change
// (title/description/priority all absent). routine_not_found is an APPLY-time
// failure (surfaced via the approval's failureReason on approve).
export type RoutineEditProposeRejectReason =
  | "permission_denied"
  | "invalid_body";

export type ProposeSkillLibraryEditBlockPayload = z.infer<
  typeof proposeSkillLibraryEditBlockPayload
>;

// skill_not_in_library is an APPLY-time failure (the key resolves to no
// company-imported skill — absent, or a platform built-in), surfaced via the
// approval's failureReason on approve.
export type SkillLibraryEditProposeRejectReason =
  | "permission_denied"
  | "invalid_body";

export type ProposeToolEditBlockPayload = z.infer<
  typeof proposeToolEditBlockPayload
>;

// tool_not_found is an APPLY-time failure (the toolId resolves to no tool in
// this company), surfaced via the approval's failureReason on approve.
export type ToolEditProposeRejectReason =
  | "permission_denied"
  | "invalid_body";

export type ProposeWorkflowDeleteBlockPayload = z.infer<
  typeof proposeWorkflowDeleteBlockPayload
>;
export type ProposeTaskDeleteBlockPayload = z.infer<
  typeof proposeTaskDeleteBlockPayload
>;

// workflow_not_found / task_not_found are APPLY-time failures, surfaced via
// the approval's failureReason on approve.
export type WorkflowDeleteProposeRejectReason =
  | "permission_denied"
  | "invalid_body";
export type SetTaskStatusBlockPayload = z.infer<
  typeof setTaskStatusBlockPayload
>;

export type CommentTaskBlockPayload = z.infer<
  typeof commentTaskBlockPayload
>;

export type EditTaskBlockPayload = z.infer<typeof editTaskBlockPayload>;

export type TaskEditRejectReason =
  | "task_not_found"
  | "task_archived"
  | "task_locked"
  | "permission_denied"
  | "invalid_body";

export type TaskCommentRejectReason =
  | "task_not_found"
  | "task_archived"
  | "permission_denied"
  | "invalid_body";

export type TaskStatusChangeRejectReason =
  | "task_not_found"
  | "task_archived"
  | "task_locked"
  | "invalid_transition"
  | "permission_denied"
  | "invalid_body";

export type TaskDeleteProposeRejectReason =
  | "permission_denied"
  | "invalid_body";

export type ActionBlockOutcome =
  | { kind: "ignored"; reason: string }
  // SET_RESULT_URL success: the assignee's deliverable URL was recorded on
  // its current task. Anchored on-chain as result_uri at completion.
  | { kind: "result_url_set"; taskId: string; resultUri: string }
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
    }
  // PROPOSE_DEPLOYMENT: a zero-authority pending proposal row was
  // created. The receipt deep-links the operator to the Approvals
  // window to supply the gateway token and deploy — nothing is
  // provisioned by this marker.
  | {
      kind: "deployment_proposed";
      proposalId: string;
      role: string;
      runtime: string;
      skillCount: number;
      suggestedName: string | null;
    }
  | {
      kind: "deployment_propose_rejected";
      reason: DeploymentProposeRejectReason;
    }
  // PROPOSE_PROFILE_EDIT: a pending profile-edit proposal row was created.
  // fieldCount = how many profile fields the CEO proposed to change. The
  // operator reviews + commits in the Approvals window; approve applies the
  // patch via the with-approval engine.
  | {
      kind: "profile_edit_proposed";
      proposalId: string;
      fieldCount: number;
    }
  | {
      kind: "profile_edit_propose_rejected";
      reason: ProfileEditProposeRejectReason;
    }
  // PROPOSE_KNOWLEDGE_EDIT: a pending knowledge-file edit proposal row was
  // created. `op` + `path` identify what the CEO drafted; the operator
  // reviews + commits in the Approvals window (approve runs the repo write).
  | {
      kind: "knowledge_edit_proposed";
      proposalId: string;
      op: "create" | "update" | "delete";
      path: string;
    }
  | {
      kind: "knowledge_edit_propose_rejected";
      reason: KnowledgeEditProposeRejectReason;
    }
  // PROPOSE_ROUTINE_EDIT: a pending routine edit/delete proposal row was
  // created. `op` + `routineId` identify what the CEO drafted; the operator
  // reviews + commits in the Approvals window (approve runs the repo write).
  | {
      kind: "routine_edit_proposed";
      proposalId: string;
      op: "update" | "delete";
      routineId: string;
    }
  | {
      kind: "routine_edit_propose_rejected";
      reason: RoutineEditProposeRejectReason;
    }
  // PROPOSE_SKILL_LIBRARY_EDIT: a pending skill-library proposal row was
  // created. `op` + `skillKey` identify the draft; approve runs the repo
  // write (import from GitHub, set allowed-roles, or remove from the
  // library).
  | {
      kind: "skill_library_edit_proposed";
      proposalId: string;
      op: "set_roles" | "remove" | "import";
      skillKey: string;
    }
  | {
      kind: "skill_library_edit_propose_rejected";
      reason: SkillLibraryEditProposeRejectReason;
    }
  // PROPOSE_TOOL_EDIT: a pending tool edit/delete proposal row was created.
  // `op` + `toolId` identify the draft; approve runs the repo write (set
  // allowed-roles, or delete the tool).
  | {
      kind: "tool_edit_proposed";
      proposalId: string;
      op: "set_roles" | "set_status" | "delete";
      toolId: string;
    }
  | {
      kind: "tool_edit_propose_rejected";
      reason: ToolEditProposeRejectReason;
    }
  // PROPOSE_WORKFLOW_DELETE / PROPOSE_TASK_DELETE: a pending delete proposal
  // row was created; approve runs the repo delete.
  | { kind: "workflow_delete_proposed"; proposalId: string; workflowYamlId: string }
  | {
      kind: "workflow_delete_propose_rejected";
      reason: WorkflowDeleteProposeRejectReason;
    }
  | { kind: "task_delete_proposed"; proposalId: string; taskId: string }
  | {
      kind: "task_delete_propose_rejected";
      reason: TaskDeleteProposeRejectReason;
    }
  // SET_TASK_STATUS: autonomous kanban move. `alreadyAtTarget` short-
  // circuits when the task is already in the requested column (idempotent
  // ack, no event/invoice fired). `billed` flags that the move into `done`
  // triggered invoice-on-task-complete so the receipt can say so.
  | {
      kind: "task_status_set";
      taskId: string;
      taskNumber: number;
      from: TaskStatus;
      to: TaskStatus;
      alreadyAtTarget: boolean;
      billed: boolean;
    }
  | {
      kind: "task_status_set_rejected";
      reason: TaskStatusChangeRejectReason;
    }
  // COMMENT_TASK: a comment was posted. `mentionCount` = resolved @mentions,
  // `wokenCount` = mentioned agents that were assigned to this task and got
  // re-dispatched to pick it up (subset of mentionCount).
  | {
      kind: "task_commented";
      taskId: string;
      taskNumber: number;
      mentionCount: number;
      wokenCount: number;
    }
  | {
      kind: "task_comment_rejected";
      reason: TaskCommentRejectReason;
    }
  // EDIT_TASK: task metadata patched. `fields` = human labels of what
  // changed, for the receipt ("Updated #42: priority, tags").
  | {
      kind: "task_edited";
      taskId: string;
      taskNumber: number;
      fields: string[];
    }
  | {
      kind: "task_edit_rejected";
      reason: TaskEditRejectReason;
    };
