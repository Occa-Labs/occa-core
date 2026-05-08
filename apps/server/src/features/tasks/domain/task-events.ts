// Pure types for the task_events log. The repository layer owns the
// drizzle schema reference; this file holds the event-type enum and the
// per-event payload shapes that producers and consumers can rely on.

export type TaskEventType =
  | "task_created"
  | "task_assigned"
  | "task_status_changed"
  | "agent_trace_started"
  | "agent_trace_finished"
  | "agent_action_emitted"
  | "comment_added"
  | "task_blocked"
  | "task_unblocked";

export type TaskEventActorType = "user" | "agent" | "system";

// Event-specific payload shapes. Keep these as the contract that producers
// honour and consumers read; the actual jsonb column is permissive but the
// payload should match these to keep the timeline UI predictable.
export interface TaskCreatedPayload {
  title: string;
  taskType: string;
  parentTaskId: string | null;
  via?: "EmitFollowUp" | "delegate" | "ui";
}

export interface TaskAssignedPayload {
  deploymentId: string | null;
  previousDeploymentId?: string | null;
}

export interface TaskStatusChangedPayload {
  from: string;
  to: string;
  reason:
    | "agent_action"
    | "user_edit"
    | "dispatch_started"
    | "trace_failed"
    | "trace_finished"
    | "trace_succeeded"
    | "blockers_resolved"
    | "child_completed";
  childTaskId?: string;
  lastBlockerTaskId?: string;
}

export interface AgentTraceStartedPayload {
  traceId: string;
  deploymentId: string;
}

export interface AgentTraceFinishedPayload {
  traceId: string;
  outcome: "success" | "review" | "blocked" | "error" | "other";
  error?: string;
}

export interface AgentActionEmittedPayload {
  // Includes block-marker tokens (HIRE/DELEGATE/BLOCK/ASK/REVIEW) and
  // HTTP-channel action types (EmitFollowUp/RequestInfo). Stable wire
  // strings — additions here are non-breaking.
  actionType: string;
  channel: "block_marker" | "http";
  outcome?: string;
  actionPayload?: unknown;
  childTaskId?: string;
  commentId?: string;
  blockerIds?: string[];
  reason?: string;
  title?: string;
}

export interface CommentAddedPayload {
  commentId: string;
  body: string;
  mentions: string[];
}

export interface TaskBlockedPayload {
  blockedByTaskIds: string[];
}

export interface TaskUnblockedPayload {
  by: "cascade" | "manual";
  lastBlockerTaskId?: string;
}

export interface AppendTaskEventInput {
  companyId: string;
  taskId: string;
  eventType: TaskEventType;
  actorType: TaskEventActorType;
  actorId?: string | null;
  payload?: Record<string, unknown>;
  traceId?: string | null;
}
