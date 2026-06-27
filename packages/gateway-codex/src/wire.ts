// Wire-protocol types — the contract shared between the Codex Gateway service
// (which produces them, Phase 2) and any HTTP client that consumes them
// (OCCA's codex adapter reads CodexStreamEvent + RunCodexResult off the
// /v1/run NDJSON stream). This module is types-only: zero runtime, so a
// client can `import type` it without pulling the server in. Keeping the
// contract here makes the gateway package its single source of truth — the
// adapter never carries a private copy that can drift.
//
// The event shape is deliberately the SAME normalized surface the Claude
// Gateway exposes (assistant_text / tool_use / tool_result / error). Codex's
// native `--json` event schema differs from Claude's `stream-json`, so the
// Phase 2 gateway translates codex events INTO this shape. That uniformity is
// what lets the OCCA-side adapter + trace feed stay runtime-agnostic.

// Normalized run event surfaced live during a streaming task run. Callers map
// these onto their own event shape (the adapter onto OCCA's AdapterTraceEvent,
// the gateway onto an NDJSON wire frame).
export interface CodexStreamEvent {
  kind: "assistant_text" | "tool_use" | "tool_result" | "error";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: string;
  isError?: boolean;
}

export interface RunCodexInput {
  prompt: string;
  cwd: string;
  /** Model alias passed to `codex -m` (e.g. "gpt-5.5-codex"). */
  model: string;
  /** OCCA's sessionKey — the gateway's LOOKUP KEY for continuity. Codex has NO
   *  flag to set a session id, so the gateway captures the `thread_id` from the
   *  first turn's `thread.started` event, stores sessionKey → thread_id, and
   *  resumes later turns via `codex exec resume <thread_id>`. Not a
   *  deterministic codex id — a gateway-side mapping (see PHASE2-REFERENCE). */
  sessionKey: string;
  /** Extra system instructions (kept small — persona/skills ride in the
   *  seeded workspace files, not here). */
  appendSystemPrompt?: string | null;
  /** Tool allowlist. Empty/omitted = no tools (pure text reply, for chat).
   *  Codex has no per-tool allow flag; the gateway maps a NON-empty list to a
   *  write-capable sandbox (`--sandbox workspace-write`) and an empty list to
   *  a read-only, no-approval sandbox (`--sandbox read-only -a never`). */
  allowedTools?: string[] | null;
  /** Tool denylist. On Claude this is literal `--disallowedTools`; on Codex
   *  there is no per-tool deny, so the gateway folds it into the same
   *  sandbox/approval policy decision as `allowedTools`. */
  disallowedTools?: string[] | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Hard dollar ceiling on the run's API spend. Codex's CLI has NO per-run
   *  USD cap flag, so the gateway IGNORES this field — run cost is bounded by
   *  `timeoutMs` plus OCCA's monthly treasury gate at dispatch time, not by
   *  truncating a live run. Kept in the wire so the adapter's call shape stays
   *  identical across runtimes. */
  maxBudgetUsd?: number;
  /** Live per-turn events (tool calls, assistant text). Omit for chat. */
  onEvent?: (event: CodexStreamEvent) => void;
}

export interface RunCodexResult {
  ok: boolean;
  reply: string;
  sessionId: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokensIn: number;
  } | null;
  /** Best-effort estimate. Codex does not always emit a dollar figure; the
   *  gateway derives it from token counts where possible, else null. */
  costUsd: number | null;
  error?: string;
  reason?: string;
}
