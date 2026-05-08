import type { AgentDTO } from "@occa/shared/types";

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
