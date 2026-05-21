// Wake payload — agent-agnostic shape passed from dispatcher → adapter.
// Never include task bodies, skill files, or secrets here beyond what's
// needed to identify the trace. Adapters fetch the rest via HTTP using
// runtimeEnv.apiKey.

import type {
  LivenessState,
  TraceUsage,
  WakeSource,
} from "@occa/shared/types";

export interface WakePayload {
  traceId: string;
  agentId: string;
  companyId: string;
  taskId: string | null;
  issueId: string | null;
  wakeReason: string | null;
  wakeCommentId: string | null;
  approvalId: string | null;
  approvalStatus: string | null;
  issueIds: string[];
  source: WakeSource;
  continuationAttempt: number;
}

// Runtime environment passed to adapters so remote agents can call back
// into OCCA (fetch skills, post events, etc.). `apiKey` is an ephemeral
// per-trace agent API key minted by the dispatcher.
export interface RuntimeEnv {
  apiUrl: string;
  apiKey: string;
  agentId: string; // external (adapter-side) agent id, from agents.externalAgentId
  traceId: string;
}

export interface WakeTextContext {
  agentName: string;
  taskTitle?: string;
  taskDescription?: string;
  // Set when the wake originates from a scheduled routine: the routine's
  // title and its standing mandate (the routine description).
  routineTitle?: string;
  routineMandate?: string;
  // Direct reports of the woken agent. Rendered into a routine wake so
  // an orchestrator has the valid `targetAgentId` values to delegate to.
  subordinates?: { id: string; name: string; role: string }[];
  // Recent episodes of the company's own coverage — date, category,
  // title. A routine orchestrator reads this to vary the next slate
  // rather than repeat a topic already covered.
  recentCoverage?: { date: string; category: string; title: string }[];
}

// Inlined into every routine wake. A routine-woken orchestrator (CEO,
// Head) hands work to its team — and must do it through OCCA's
// `[[OCCA:DELEGATE]]` marker, never by spawning native runtime
// sub-agents (which bypass the task board, review, and the gate).
export const DELEGATION_CONTRACT = [
  "DELEGATION — how to hand work to your team. MANDATORY.",
  "",
  "To delegate a task, emit this block in your reply — one block per",
  "task, targetAgentId taken from the team roster below:",
  "",
  "[[OCCA:DELEGATE]]",
  "{",
  '  "targetAgentId": "<id from Your team below>",',
  '  "title": "<short task title>",',
  '  "description": "<full brief: angle, must-cover points, constraints>",',
  '  "acceptanceCriteria": "<optional — what done looks like>"',
  "}",
  "[[/OCCA:DELEGATE]]",
  "",
  "OCCA creates the task, assigns it, and dispatches it automatically.",
  "Do NOT spawn sub-agents, sub-sessions, or any native runtime helper",
  "to do the work — that bypasses OCCA entirely: nothing lands on the",
  "task board, nothing is reviewed, nothing is verified. Delegation",
  "happens ONLY through the [[OCCA:DELEGATE]] block above.",
].join("\n");

export function buildWakeText(
  payload: WakePayload,
  ctx: WakeTextContext,
): string {
  const lines: string[] = [];
  lines.push(`Hello ${ctx.agentName}. You have been woken up (${payload.source}).`);
  if (payload.taskId && ctx.taskTitle) {
    lines.push("");
    lines.push(`Task: ${ctx.taskTitle}`);
    if (ctx.taskDescription) lines.push(ctx.taskDescription);
    lines.push(`Task ID: ${payload.taskId}`);
  }
  // A routine wake carries no task — surface the standing mandate so the
  // agent knows what the schedule expects of it this run, plus the
  // delegation contract + team roster (it does not reliably read
  // AGENTS.md, so the "how" must travel inline).
  if (ctx.routineTitle) {
    lines.push("");
    lines.push(`Standing routine: ${ctx.routineTitle}`);
    if (ctx.routineMandate) lines.push(ctx.routineMandate);
    // The company's own recent coverage — so the orchestrator can vary
    // the next slate instead of repeating a topic.
    if (ctx.recentCoverage && ctx.recentCoverage.length > 0) {
      lines.push("");
      lines.push(
        "Recently published — vary the next slate from this, do not " +
          "repeat a topic or lean on a category already run heavily:",
      );
      for (const c of ctx.recentCoverage) {
        lines.push(`  - ${c.date} [${c.category}] ${c.title}`);
      }
    }
    lines.push("");
    lines.push(DELEGATION_CONTRACT);
    if (ctx.subordinates && ctx.subordinates.length > 0) {
      lines.push("");
      lines.push("Your team — valid targetAgentId values:");
      for (const s of ctx.subordinates) {
        lines.push(`  - ${s.name} (${s.role}) — ${s.id}`);
      }
    } else {
      lines.push("");
      lines.push(
        "You have no subordinates to delegate to. Report what you " +
          "would assign and stop — do not spawn helpers to do it.",
      );
    }
  } else if (payload.wakeReason) {
    lines.push("");
    lines.push(`Wake reason: ${payload.wakeReason}`);
  }
  if (payload.continuationAttempt > 0) {
    lines.push(
      `This is continuation attempt ${payload.continuationAttempt}. Make a concrete action this turn.`,
    );
  }
  return lines.join("\n");
}

// Adapter-side summary the dispatcher persists after a trace completes.
export interface AdapterTraceResult {
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
  livenessState: LivenessState | null;
  usage: TraceUsage | null;
  error: { code: string; message: string } | null;
  sessionIdAfter: string | null;
  resultJson: Record<string, unknown> | null;
}
