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
}

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
  if (payload.wakeReason) {
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
