// Wire-protocol types — the contract shared between the gateway service
// (which produces them) and any HTTP client that talks to it (OCCA's
// claude-code adapter consumes ClaudeStreamEvent + RunClaudeResult off the
// /v1/run NDJSON stream). This module is types-only: zero runtime, so a
// client can `import type` it without pulling the server in. Keeping the
// contract here makes the gateway package its single source of truth — the
// adapter never carries a private copy that can drift.

// Normalized run event surfaced live during a streaming task run. Callers map
// these onto their own event shape (the adapter onto OCCA's AdapterTraceEvent,
// the gateway onto an NDJSON wire frame).
export interface ClaudeStreamEvent {
  kind: "assistant_text" | "tool_use" | "tool_result" | "error";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: string;
  isError?: boolean;
}

export interface RunClaudeInput {
  prompt: string;
  cwd: string;
  model: string;
  sessionUuid: string;
  /** Extra system instructions (kept small — persona/skills ride in the
   *  seeded workspace files, not here). */
  appendSystemPrompt?: string | null;
  /** Tool allowlist. Empty/omitted = no tools (pure text reply, for chat). */
  allowedTools?: string[] | null;
  /** Tool denylist — takes precedence over any host-side permission
   *  allowlist. Needed because an empty `--allowedTools` does NOT block a
   *  tool the host's settings.json already approves; `--disallowedTools`
   *  does. Used to keep chat strictly text-only and to block subagent
   *  spawning on tasks. */
  disallowedTools?: string[] | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Hard dollar ceiling on the run's API spend (`--max-budget-usd`). The
   *  CLI ends the run once spend crosses this, bounding both cost and the
   *  runaway research-loop that otherwise burns the full timeout. Omit for
   *  unbounded (chat — short by nature). */
  maxBudgetUsd?: number;
  /** Live per-turn events (tool calls, assistant text). Omit for chat. */
  onEvent?: (event: ClaudeStreamEvent) => void;
}

export interface RunClaudeResult {
  ok: boolean;
  reply: string;
  sessionId: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokensIn: number;
  } | null;
  costUsd: number | null;
  error?: string;
  reason?: string;
}
