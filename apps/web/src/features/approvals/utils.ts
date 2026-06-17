import type { AgentDTO } from "@occa/shared/types";

// Operator-facing label for a terminal approval status. The "cancelled"
// status is what a dismiss writes, but users know the action as "Dismiss",
// so we surface it as "dismissed" in chips/badges. Other statuses render
// as-is.
export function approvalStatusLabel(status: string): string {
  return status === "cancelled" ? "dismissed" : status;
}

// Best-effort humanization. Approvals carry a free-form `actionType` string;
// when the actionType is a known structured kind (currently `delegate`)
// we pull typed fields and resolve referenced agent IDs to names.
// Otherwise we fall back to `payload.summary` then a slug → "Wants to …"
// rendering.
export function humanizeApprovalAction(
  actionType: string,
  payload: Record<string, unknown>,
  agentById: Map<string, AgentDTO>,
): string {
  if (actionType === "delegate") {
    const targetId =
      typeof payload.targetAgentId === "string" ? payload.targetAgentId : null;
    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    const targetName = targetId
      ? (agentById.get(targetId)?.name ?? null)
      : null;
    if (targetName && title)
      return `Wants to delegate to ${targetName}: "${title}"`;
    if (targetName) return `Wants to delegate to ${targetName}`;
    if (title) return `Wants to delegate: ${title}`;
    return "Wants to delegate to another agent";
  }

  if (actionType === "propose_deployment") {
    const role = typeof payload.role === "string" ? payload.role : null;
    const name =
      typeof payload.suggestedName === "string"
        ? payload.suggestedName.trim()
        : "";
    if (role && name) return `Wants to deploy ${name} — a ${role} agent`;
    if (role) return `Wants to deploy a ${role} agent`;
    return "Wants to deploy a new agent";
  }

  if (actionType === "edit_company_profile") {
    const n = Object.keys(payload).length;
    return n === 1
      ? "Wants to update 1 company profile field"
      : `Wants to update ${n} company profile fields`;
  }

  if (actionType === "edit_knowledge") {
    const op = typeof payload.op === "string" ? payload.op : "";
    const path = typeof payload.path === "string" ? payload.path : "";
    const verb =
      op === "create" ? "add" : op === "delete" ? "remove" : "update";
    return path
      ? `Wants to ${verb} knowledge file ${path}`
      : "Wants to edit a knowledge file";
  }

  if (actionType === "edit_routine") {
    const op = typeof payload.op === "string" ? payload.op : "";
    return op === "delete"
      ? "Wants to delete a routine"
      : "Wants to edit a routine's mandate";
  }

  if (actionType === "edit_skill_library") {
    const op = typeof payload.op === "string" ? payload.op : "";
    const key = typeof payload.skillKey === "string" ? payload.skillKey : "";
    if (op === "import")
      return key
        ? `Wants to import skill ${key} into the library`
        : "Wants to import a skill into the library";
    if (op === "remove")
      return key
        ? `Wants to remove skill ${key} from the library`
        : "Wants to remove a skill from the library";
    return key
      ? `Wants to set allowed roles for skill ${key}`
      : "Wants to change a skill's allowed roles";
  }

  if (actionType === "edit_tool") {
    const op = typeof payload.op === "string" ? payload.op : "";
    if (op === "delete") return "Wants to delete a tool";
    if (op === "set_status") {
      const status =
        typeof payload.status === "string" ? payload.status : "change";
      return `Wants to ${status === "paused" ? "pause" : status === "active" ? "activate" : "change"} a tool`;
    }
    return "Wants to change a tool's allowed roles";
  }

  if (actionType === "delete_workflow") return "Wants to delete a workflow";
  if (actionType === "delete_task") return "Wants to delete a task";

  if (actionType === "create_workflow") return "Wants to create a workflow";

  if (actionType === "edit_workflow") {
    const hasYaml = typeof payload.yamlText === "string";
    const hasEnabled = typeof payload.enabled === "boolean";
    if (hasYaml && hasEnabled)
      return `Wants to rewrite a workflow and ${payload.enabled ? "enable" : "disable"} it`;
    if (hasEnabled)
      return `Wants to ${payload.enabled ? "enable" : "disable"} a workflow`;
    return "Wants to rewrite a workflow's steps";
  }

  const summary =
    typeof payload.summary === "string" ? payload.summary.trim() : "";
  if (summary) return summary;
  const pretty = actionType
    .split(/[._-]+/)
    .filter(Boolean)
    .join(" ");
  return pretty ? `Wants to ${pretty.toLowerCase()}` : "Awaiting your decision";
}

// Keys whose string values render as markdown in the detail view. Agents
// write description / acceptance / summary as prose with lists, code, and
// links — rendering them as plain text strips the formatting. Anything
// else (uuids, role slugs, names) stays as a plain monoline.
export const MARKDOWN_PAYLOAD_KEYS = new Set([
  "description",
  "acceptanceCriteria",
  "summary",
  "note",
  "rejectionReason",
  "failureReason",
  "content",
]);

// Payload keys that represent system / lifecycle metadata stamped by the
// server, not user-facing request fields. Hide from the editable form
// surface (Phase 3 HITL edit) but still safe to render in read-only view.
export const SYSTEM_PAYLOAD_KEYS = new Set([
  "spawnedTaskId",
  "spawnedAgentId",
  "failureReason",
  "failedAt",
  "originalPayload",
  "editedByUserId",
  "editedAt",
  "parentTaskId",
]);

// Data the "Deploy this" handoff carries up from a propose_deployment
// approval to the shell, which opens the pre-filled deploy modal. No
// credentials — the operator enters the gateway endpoint + token in the
// modal, never here.
export interface DeployProposalRequest {
  proposalId: string;
  role: string;
  runtime: string;
  suggestedName: string | null;
  desiredSkills: string[];
}

// Narrow an opaque approval payload into a DeployProposalRequest.
export function readDeployProposal(
  proposalId: string,
  payload: Record<string, unknown>,
): DeployProposalRequest {
  const role = typeof payload.role === "string" ? payload.role : "";
  const runtime = typeof payload.runtime === "string" ? payload.runtime : "";
  const suggestedName =
    typeof payload.suggestedName === "string" ? payload.suggestedName : null;
  const desiredSkills = Array.isArray(payload.desiredSkills)
    ? payload.desiredSkills.filter((s): s is string => typeof s === "string")
    : [];
  return { proposalId, role, runtime, suggestedName, desiredSkills };
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function stringifyPayloadValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
