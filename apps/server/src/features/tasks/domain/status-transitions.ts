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
  // Legacy HITL approval path — kept for the (currently unused)
  // approval-row flow if other action types ever resurface it. As of
  // Phase A, DELEGATE no longer creates approval rows.
  approvalsRequested: number;
  // Auto-approved delegations: child tasks the agent spawned this turn
  // via [[OCCA:DELEGATE]]. While children are running the parent has
  // nothing to do, so we park it in `review` until cascade re-wakes it.
  delegationsSpawned: number;
  // BLOCK action flagged blockers — overrides everything else.
  blockedBy: string[] | null;
  // [[OCCA:REVIEW]] single-tag marker found in the reply.
  needsReview: boolean;
}

// Single source of truth for "what status should this task be in after
// the agent's reply?" Decision tree:
//   BLOCK    → `blocked` (overrides everything else)
//   REVIEW   → `review`
//   approval pending (legacy) → `review`
//   delegation spawned a child → `review` (waiting on cascade)
//   default  → `done`
//
// Clarification questions don't show up here: they go through
// RequestInfo HTTP, which pauses the task itself.
export function nextStatusAfterDispatch(
  flags: DispatchOutcomeFlags,
): TaskStatus {
  if (flags.blockedBy && flags.blockedBy.length > 0) return "blocked";
  if (flags.needsReview) return "review";
  if (flags.approvalsRequested > 0) return "review";
  if (flags.delegationsSpawned > 0) return "review";
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
  // Technical failure → operator sends it back to todo to retry (or
  // dismisses to archive, which is not a status transition).
  error: new Set<TaskStatus>(["todo"]),
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
    // The trace itself succeeded but the dispatcher is re-queuing the task to
    // `todo` to re-run it — the auto-bounce path (e.g. a Head that emitted a
    // DELEGATE inside a workflow step, which the engine drops, so we bounce it
    // back to do the step's work itself). The agent ran fine, so the trace
    // outcome is still `success`; `todo` is a task-status routing decision, not
    // a trace failure. Without this case the bounce throws here, the close
    // aborts before the bounce comment posts, the cap never increments, and the
    // task re-dispatches forever (observed: a Brief-story step looping 17×).
    case "todo":
      return "success";
    default:
      throw new Error(
        `traceOutcomeFor: unexpected nextStatus "${status}" — dispatcher should not transition to this from a successful trace`,
      );
  }
}
