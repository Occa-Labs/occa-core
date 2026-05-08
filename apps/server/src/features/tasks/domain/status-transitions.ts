// Pure FSM rules for task status. Today the transition logic lives
// implicitly across task-dispatcher (decides next status from action
// outcomes) and task-cascade (resets parents/dependents). Centralising
// the rules here means every transition has one canonical predicate and
// the dispatcher reads as a sequence of `nextStatusFrom(...)` calls
// instead of inline ternaries.

import type { TaskStatus } from "@occa/shared/types";

// Stable list of states a task can be parked in waiting for human
// attention. Anything in here means "agent finished a turn but cannot
// proceed without user input."
export const REVIEW_STATES = new Set<TaskStatus>(["review"]);

// Active states a system-driven advance is allowed to mutate. Used as
// the `from` filter on UPDATEs so we never resurrect cancelled or
// already-closed tasks.
export const ADVANCEABLE_STATES = new Set<TaskStatus>(["todo", "in_progress"]);

export interface DispatchOutcomeFlags {
  // Agent emitted at least one DELEGATE that produced a pending
  // approval — task parks in `review` until the human decides.
  approvalsRequested: number;
  // BLOCK action flagged blockers — overrides everything else.
  blockedBy: string[] | null;
  // [[OCCA:REVIEW]] single-tag marker found in the reply.
  needsReview: boolean;
}

// Single source of truth for "what status should this task be in after
// the agent's reply?" Decision tree:
//   BLOCK    → `blocked` (overrides everything else)
//   REVIEW   → `review`
//   approval pending (DELEGATE) → `review`
//   default  → `done`
//
// Clarification questions don't show up here: per task-system-design.md
// they go through RequestInfo HTTP, which pauses the task itself.
export function nextStatusAfterDispatch(
  flags: DispatchOutcomeFlags,
): TaskStatus {
  if (flags.blockedBy && flags.blockedBy.length > 0) return "blocked";
  if (flags.needsReview) return "review";
  if (flags.approvalsRequested > 0) return "review";
  return "done";
}

// Outcome label for the `agent_trace_finished` event payload. Mirrors
// the next-status decision but in the trace lifecycle vocabulary —
// design doc spec enumerates exactly 4 values: success | error | review
// | blocked. The `error` branch is set directly by the failed-trace
// path (not via this fn). Anything that lands here outside the 3
// success-side states is a programming error.
export type AgentTraceOutcome = "success" | "error" | "review" | "blocked";

// Whitelist of manual status transitions a user is allowed to drive
// from the task-detail dropdown. Anything not in this map is rejected
// at the route layer — keeps `in_progress` from being set without a
// dispatch, and keeps `done` from being walked back into a working
// state (rerun handles re-execution explicitly).
const ALLOWED_USER_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  todo: new Set<TaskStatus>(["review", "done"]),
  in_progress: new Set<TaskStatus>(["todo", "review", "done"]),
  review: new Set<TaskStatus>(["todo", "done"]),
  blocked: new Set<TaskStatus>(["todo", "review", "done"]),
  done: new Set<TaskStatus>([]), // terminal — must rerun or unarchive
};

export function isUserStatusTransitionAllowed(
  from: TaskStatus,
  to: TaskStatus,
): boolean {
  if (from === to) return true;
  return ALLOWED_USER_TRANSITIONS[from]?.has(to) ?? false;
}

export function traceOutcomeFor(status: TaskStatus): AgentTraceOutcome {
  switch (status) {
    case "done":
      return "success";
    case "review":
      return "review";
    case "blocked":
      return "blocked";
    default:
      throw new Error(
        `traceOutcomeFor: unexpected nextStatus "${status}" — dispatcher should not transition to this from a successful trace`,
      );
  }
}
