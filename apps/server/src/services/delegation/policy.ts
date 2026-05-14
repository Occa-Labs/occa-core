// Single source of truth for the hierarchical delegation algorithm
// (User ↔ CEO ↔ Head ↔ Specialist). Used by:
//   • services/context/load-context.ts — sort subordinates by tier
//     preference before they reach the prompt
//   • services/context/render-task.ts — render the "Available reports"
//     + REPORT instructions blocks shown to every task-running agent
//   • features/tasks/services/dispatcher.ts — server-side bypass guard
//     that rejects REPORT when delegation was due but skipped
//
// Centralising the rules here prevents drift between (a) what the LLM
// is told and (b) what the server enforces. If the algorithm changes,
// edit this file — every callsite that imports from it stays in sync.
//
// ─── Algorithm (mirrors the hierarchical-agent-system design diagram) ───
//
//   USER
//    │
//    ▼
//   CEO
//    ├── no subordinates ──► execute self end-to-end + REPORT to user
//    │
//    └── has subordinates ──► DELEGATE by tier priority:
//          ├── has matching Head ──► delegate to Head
//          │     └── Head:
//          │          ├── has specialist ──► delegate to specialist
//          │          │     └── specialist works → done → cascade
//          │          │          → Head reviews → done → cascade
//          │          │          → CEO REPORT to user
//          │          └── no specialist ──► Head self-executes
//          │                                → done → cascade
//          │                                → CEO REPORT to user
//          └── no Head, has specialist ──► CEO delegates directly to
//                specialist → specialist done → cascade → CEO REPORT
//
// Only the CEO ever emits REPORT to the user. Every other layer bubbles
// up via cascade-on-done (parent task wakes when all children finish).

import type { RoleTier } from "@occa/shared/role-catalog";
import type { ContextTeammate } from "../context/spec";

// Delegation preference ordering for an agent's subordinates list. Lower
// rank = surfaced first to the LLM. The task-surface prompt teaches the
// agent: delegate to a Head when one fits, fall back to specialist /
// direct-report, and otherwise execute the task itself. Direct reports
// (chief_of_staff, finance_lead, legal_counsel) sit between Heads and
// specialists — CEO-direct contributors, not domain commanders.
export function tierRank(tier: RoleTier | "unknown"): number {
  switch (tier) {
    case "head":
      return 0;
    case "direct_report":
      return 1;
    case "specialist":
      return 2;
    default:
      return 3;
  }
}

// Stable sort of an agent's subordinates so the highest-priority
// delegation target appears first. Callers should treat the returned
// array as the canonical "available reports" list shown to the LLM.
export function sortByDelegationPriority(
  subordinates: ContextTeammate[],
): ContextTeammate[] {
  return [...subordinates].sort(
    (a, b) => tierRank(a.tier) - tierRank(b.tier),
  );
}

// Server-side bypass guard. The LLM is told "if subordinates exist you
// MUST delegate"; this predicate is the matching server-side check that
// runs after the reply is parsed. When all four conditions hold it
// means the agent skipped delegation and tried to ship its own work as
// the user-facing REPORT — we refuse to commit that REPORT, and the
// existing `missingRootReport` safeguard flips the task to `review`.
//
// Why all four conditions:
//   • isRoot — only root tasks bubble back to the user; sub-task
//     REPORTs are nonsensical and handled by handleReportBlock first
//   • hasSubordinates — without anyone to delegate to, self-execution
//     is the correct path
//   • !wasDelegated — DELEGATE this turn means CEO is starting the
//     subtree, not closing it; REPORT alongside DELEGATE is malformed
//     but not a bypass
//   • !hasCompletedChildren — once children have shipped, REPORT is
//     the synthesis turn (cascade-then-REPORT chain) — not a bypass
export function shouldBypassReport(args: {
  isRoot: boolean;
  hasSubordinates: boolean;
  wasDelegated: boolean;
  hasCompletedChildren: boolean;
}): boolean {
  return (
    args.isRoot &&
    args.hasSubordinates &&
    !args.wasDelegated &&
    !args.hasCompletedChildren
  );
}

// Prompt fragment shown to every task-running agent. The text is the
// LLM-facing twin of `shouldBypassReport`: it teaches the priority
// ladder and explicitly forbids self-execution when subordinates exist.
// When the subordinates list is empty, the wording flips to a clean
// "you ARE the doer" path so the agent doesn't stall trying to
// delegate into a void.
export function renderReportsBlock(reports: ContextTeammate[]): string {
  if (reports.length === 0) {
    return [
      `Available reports (DELEGATE): none.`,
      `You have no agents reporting to you. Execute the task yourself`,
      `end-to-end this turn — you ARE the doer.`,
    ].join("\n");
  }
  const groups: Record<string, ContextTeammate[]> = {
    head: [],
    direct_report: [],
    specialist: [],
    other: [],
  };
  for (const r of reports) {
    const key =
      r.tier === "head" ||
      r.tier === "direct_report" ||
      r.tier === "specialist"
        ? r.tier
        : "other";
    groups[key].push(r);
  }
  const lines = [
    `Available reports (DELEGATE — assign work to an existing teammate):`,
    ``,
    `*** DELEGATION IS MANDATORY THIS TURN. ***`,
    `You have subordinates listed below. You are a router + reviewer, not`,
    `an individual contributor — your job is to PICK the right teammate`,
    `and emit [[OCCA:DELEGATE]] with their id. Do NOT write the`,
    `deliverable yourself in this reply, even if you could. The user is`,
    `paying for an org, not a one-person show.`,
    ``,
    `Picking order:`,
    `  1. Prefer a HEAD whose domain matches the task — Heads own a`,
    `     department and route + execute within it.`,
    `  2. If no Head fits, fall back to the best-matching SPECIALIST or`,
    `     DIRECT REPORT below. Imperfect role-fit is FINE — pick the`,
    `     closest match (a specialist writer can draft adjacent content`,
    `     even if it's not strictly their lane).`,
    `  3. Self-execution is ONLY allowed when this section says "none".`,
    `     Right now it does not — DELEGATE.`,
  ];
  if (groups.head.length > 0) {
    lines.push(``, `Heads (try here first):`);
    for (const r of groups.head)
      lines.push(`  - ${r.name} (role: ${r.role}, id: ${r.id})`);
  }
  if (groups.direct_report.length > 0) {
    lines.push(``, `Direct reports (CEO-direct contributors):`);
    for (const r of groups.direct_report)
      lines.push(`  - ${r.name} (role: ${r.role}, id: ${r.id})`);
  }
  if (groups.specialist.length > 0) {
    lines.push(``, `Specialists (fallback when no Head fits):`);
    for (const r of groups.specialist)
      lines.push(`  - ${r.name} (role: ${r.role}, id: ${r.id})`);
  }
  if (groups.other.length > 0) {
    lines.push(``, `Other reports:`);
    for (const r of groups.other)
      lines.push(`  - ${r.name} (role: ${r.role}, id: ${r.id})`);
  }
  return lines.join("\n");
}

// Root-task-only prompt fragment for the REPORT marker. Subordinate
// tasks never bubble back to the user directly (handleReportBlock
// rejects non-root REPORTs), so we don't tempt specialists or Heads
// with this surface. CEO sees it on every root task; the "synthesize
// and ship" cue is reinforced by the completed-children block in
// render-task when children have already shipped to CEO.
export function renderRootReportBlock(): string {
  return [
    `THIS TASK WRAPS A USER REQUEST FROM CHAT (root task).`,
    `When the work is done and you're ready to deliver to the user,`,
    `emit this marker — whatever you put BETWEEN the tags is posted`,
    `verbatim to the user's chat thread as your reply:`,
    ``,
    `    [[OCCA:REPORT]]`,
    `    Your full markdown summary goes here, as plain text — not JSON.`,
    `    Use markdown freely (headings, lists, code blocks, links). The`,
    `    user reads this directly in chat, so write the way you'd talk`,
    `    to them. Include what was shipped, key findings, and any`,
    `    followups you'd suggest.`,
    `    [[/OCCA:REPORT]]`,
    ``,
    `Body is plain markdown — DO NOT wrap it in JSON or code fences.`,
    `Without REPORT the user gets nothing — closing the task silently`,
    `is not delivery. Pair REPORT with finishing the task in the same`,
    `reply (no extra BLOCK / DELEGATE alongside REPORT in this turn).`,
  ].join("\n");
}
