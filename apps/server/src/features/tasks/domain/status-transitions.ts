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
  // Agent emitted at least one HIRE / DELEGATE that produced a pending
  // approval — task parks in `review` until the human decides.
  approvalsRequested: number;
  // BLOCK action flagged blockers — overrides everything else.
  blockedBy: string[] | null;
  // ASK action posted a comment — same parking rule as approvals.
  askPosted: boolean;
  // [[OCCA:REVIEW]] single-tag marker found in the reply.
  needsReview: boolean;
}

// Single source of truth for "what status should this task be in after
// the agent's reply?" Matches the legacy decision tree from
// task-dispatcher.ts:533-548 exactly:
//   BLOCK   → `blocked` (overrides everything else)
//   REVIEW  → `review`
//   approval/ask pending → `review`
//   default → `done`
export function nextStatusAfterDispatch(
  flags: DispatchOutcomeFlags,
): TaskStatus {
  if (flags.blockedBy && flags.blockedBy.length > 0) return "blocked";
  if (flags.needsReview) return "review";
  if (flags.approvalsRequested > 0 || flags.askPosted) return "review";
  return "done";
}

// Outcome label for the `agent_trace_finished` event payload. Mirrors
// the next-status decision but in the trace lifecycle vocabulary.
export function traceOutcomeFor(status: TaskStatus): string {
  switch (status) {
    case "done":
      return "success";
    case "review":
      return "review";
    case "blocked":
      return "blocked";
    default:
      return "other";
  }
}
