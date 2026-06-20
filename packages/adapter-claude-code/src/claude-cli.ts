// Thin wrapper around the `claude` CLI in print mode (`claude -p`). Drives
// Claude Code as a local subprocess: one invocation per turn. Task runs use
// `--output-format stream-json` so the agent's per-turn tool calls and
// assistant messages surface as a live event stream (parity with openclaw's
// gateway frames); the trailing `result` line carries the authoritative
// reply + aggregate usage. Conversation continuity rides on Claude Code's own
// session store via a deterministic session id (resume-first, create-on-miss).
//
// Auth is inherited from the process environment — CLAUDE_CODE_OAUTH_TOKEN
// (from `claude setup-token`, a Pro/Max subscription) on a server, or the
// interactive login on a dev machine. This module never handles the token.
//
// Shared by the claude-code adapter (local mode) and the claude-gateway
// service (remote BYORT mode). It is OCCA-neutral — node builtins only.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

// Binary path override for hosts where `claude` isn't on the service PATH.
const CLAUDE_BIN = process.env.OCCA_CLAUDE_BIN ?? "claude";

// Map OCCA's sessionKey (e.g. "agent:occa-x:thread:uuid:gen0") to a stable
// UUID Claude Code accepts for --session-id. Deterministic so every turn
// of the same thread resolves to the same Claude session.
export function sessionUuidFromKey(sessionKey: string): string {
  const h = createHash("sha1").update(sessionKey).digest("hex");
  // Shape as a v5-style UUID (version nibble 5, RFC-4122 variant 8).
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    `8${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

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

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
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

// Mutable accumulator filled as NDJSON lines stream in. The `result` line
// is authoritative for reply/usage/cost; assistant/tool lines drive live
// events and provide a fallback reply.
interface StreamState {
  sessionId: string | null;
  resultText: string;
  lastAssistantText: string;
  usage: ClaudeUsage | null;
  costUsd: number | null;
  isError: boolean;
  errorMessage: string | null;
  resultSubtype: string | null;
  sawResult: boolean;
}

function newStreamState(): StreamState {
  return {
    sessionId: null,
    resultText: "",
    lastAssistantText: "",
    usage: null,
    costUsd: null,
    isError: false,
    errorMessage: null,
    resultSubtype: null,
    sawResult: false,
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Route one parsed NDJSON line into the accumulator and emit live events.
function handleLine(
  obj: Record<string, unknown>,
  state: StreamState,
  onEvent?: (event: ClaudeStreamEvent) => void,
): void {
  const type = asString(obj.type);
  const sessionId = asString(obj.session_id);
  if (sessionId) state.sessionId = sessionId;

  if (type === "assistant") {
    const message = asRecord(obj.message);
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const raw of content) {
        const block = asRecord(raw);
        if (!block) continue;
        const blockType = asString(block.type);
        if (blockType === "text") {
          const text = asString(block.text);
          if (text) {
            state.lastAssistantText = text;
            onEvent?.({ kind: "assistant_text", text });
          }
        } else if (blockType === "tool_use") {
          onEvent?.({
            kind: "tool_use",
            toolName: asString(block.name) ?? "tool",
            toolInput: block.input,
          });
        }
        // "thinking" blocks are internal reasoning — not surfaced.
      }
    }
    return;
  }

  if (type === "user") {
    const message = asRecord(obj.message);
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const raw of content) {
        const block = asRecord(raw);
        if (!block || asString(block.type) !== "tool_result") continue;
        const resultStr =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
        onEvent?.({
          kind: "tool_result",
          toolResult: resultStr.slice(0, 2000),
          isError: block.is_error === true,
        });
      }
    }
    return;
  }

  if (type === "result") {
    state.sawResult = true;
    state.resultSubtype = asString(obj.subtype);
    state.isError = obj.is_error === true;
    const resultText = asString(obj.result);
    if (resultText) state.resultText = resultText;
    const usage = asRecord(obj.usage);
    if (usage) state.usage = usage as ClaudeUsage;
    if (typeof obj.total_cost_usd === "number") state.costUsd = obj.total_cost_usd;
    if (state.isError) {
      const errs = obj.errors;
      state.errorMessage = Array.isArray(errs)
        ? errs.map((e) => String(e)).join("; ")
        : resultText ?? "claude reported error";
      // A result-line error is NOT forwarded as a live event: the
      // resume-first miss produces one on every new session, and it would
      // surface as a spurious error row before the create-retry succeeds.
      // Genuine run failures are surfaced via the !ok return path instead.
      // Mid-run tool failures still ride tool_result.isError.
    }
  }
}

interface SpawnOutput {
  code: number | null;
  rawStdout: string;
  rawStderr: string;
  state: StreamState;
  // External cancel via the caller's AbortSignal (dispatcher killed the run).
  aborted: boolean;
  // Our own timeout window elapsed. Distinct from `aborted` so the result
  // maps to a `timed_out` outcome instead of `cancelled` — matches the
  // openclaw adapter's two-stage timeout handling.
  timedOut: boolean;
}

function spawnClaude(
  input: RunClaudeInput,
  mode: "resume" | "create",
  format: "stream-json" | "json",
  onEvent?: (event: ClaudeStreamEvent) => void,
): Promise<SpawnOutput> {
  const args = ["-p", "--output-format", format];
  // stream-json is rejected without --verbose.
  if (format === "stream-json") args.push("--verbose");
  args.push("--model", input.model);
  if (mode === "resume") args.push("--resume", input.sessionUuid);
  else args.push("--session-id", input.sessionUuid);
  if (input.appendSystemPrompt && input.appendSystemPrompt.length > 0) {
    args.push("--append-system-prompt", input.appendSystemPrompt);
  }
  if (input.allowedTools && input.allowedTools.length > 0) {
    args.push("--allowedTools", input.allowedTools.join(","));
  } else {
    // Pure conversational turn — empty allowlist. NOTE: this alone does
    // not block a tool the host already approves; the caller pairs it with
    // disallowedTools below for a hard deny.
    args.push("--allowedTools", "");
  }
  if (input.disallowedTools && input.disallowedTools.length > 0) {
    args.push("--disallowedTools", input.disallowedTools.join(","));
  }
  if (input.maxBudgetUsd && input.maxBudgetUsd > 0) {
    args.push("--max-budget-usd", String(input.maxBudgetUsd));
  }

  return new Promise<SpawnOutput>((resolve) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const state = newStreamState();
    let rawStdout = "";
    let rawStderr = "";
    let lineBuf = "";
    let aborted = false;
    let timedOut = false;

    // Parse complete NDJSON lines as they arrive. Non-JSON lines (e.g. a
    // "No conversation found" notice printed before the result object) are
    // kept in rawStdout for missing-session detection but skipped here.
    const consume = (chunk: string) => {
      lineBuf += chunk;
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        routeLine(line);
      }
    };
    const routeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj: Record<string, unknown> | null = null;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return;
      }
      if (obj) handleLine(obj, state, onEvent);
    };

    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };
    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = input.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, input.timeoutMs)
      : null;

    child.stdout.on("data", (d) => {
      const s = d.toString();
      rawStdout += s;
      consume(s);
    });
    child.stderr.on("data", (d) => (rawStderr += d.toString()));
    child.on("error", (err) => {
      rawStderr += `\nspawn_error: ${err instanceof Error ? err.message : String(err)}`;
      finish(null);
    });
    child.on("close", (code) => {
      // Flush any trailing partial line.
      if (lineBuf.trim()) routeLine(lineBuf);
      finish(code);
    });

    function finish(code: number | null) {
      if (timer) clearTimeout(timer);
      if (input.signal) input.signal.removeEventListener("abort", onAbort);
      resolve({ code, rawStdout, rawStderr, state, aborted, timedOut });
    }

    // Prompt over stdin avoids ARG_MAX limits on long wake text.
    child.stdin.write(input.prompt);
    child.stdin.end();
  });
}

// A resume against an unknown session id — fall back to creating it.
function isMissingSession(out: SpawnOutput): boolean {
  const hay = `${out.rawStderr} ${out.rawStdout} ${
    out.state.errorMessage ?? ""
  }`.toLowerCase();
  if (/no conversation|no session|session .*not found|not found.*session|unknown session/.test(hay)) {
    return true;
  }
  // error_during_execution with a non-zero exit and a session/resume hint.
  return (
    out.state.resultSubtype === "error_during_execution" &&
    /resume|session/.test(hay)
  );
}

// A create against a session id that already exists. "in use" really means the
// session is real — so resume it instead of failing. Mirror of isMissingSession.
function isSessionInUse(out: SpawnOutput): boolean {
  const hay = `${out.rawStderr} ${out.rawStdout} ${
    out.state.errorMessage ?? ""
  }`.toLowerCase();
  return /already in use|session id .*in use/.test(hay);
}

// A transient connection/network drop surfaced as a failed run (e.g. "The
// socket connection was closed unexpectedly"). The worker's retry policy keys
// off the error code, so label these `network_error` (transient → auto-retried
// with backoff) rather than `prompt_failed` (treated as permanent → parked).
function isConnectionDrop(text: string): boolean {
  return /socket (connection|hang)|connection (closed|reset|refused|error)|network error|econn(reset|refused|aborted)|etimedout|fetch failed|premature close|stream (closed|disconnected|error)/i.test(
    text,
  );
}

function mapUsage(usage: ClaudeUsage | null): RunClaudeResult["usage"] {
  if (!usage) return null;
  // Anthropic bills input across three buckets; OCCA's `inputTokens` is the
  // fresh (non-cache-read) input, so fold cache-creation into it and keep
  // cache-read separate. Dropping cache-creation here undercounts a Claude
  // Code turn by ~the full system-prompt size on first contact.
  const fresh = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return {
    inputTokens: fresh,
    outputTokens: usage.output_tokens ?? 0,
    cachedTokensIn: usage.cache_read_input_tokens ?? 0,
  };
}

function toResult(out: SpawnOutput): RunClaudeResult {
  if (out.timedOut) {
    return {
      ok: false,
      reply: "",
      sessionId: out.state.sessionId,
      usage: null,
      costUsd: null,
      error: "timeout",
      reason: "claude run exceeded timeout",
    };
  }
  if (out.aborted) {
    return {
      ok: false,
      reply: "",
      sessionId: out.state.sessionId,
      usage: null,
      costUsd: null,
      error: "cancelled",
      reason: "run aborted",
    };
  }
  const s = out.state;
  if (!s.sawResult) {
    const reason = (out.rawStderr || "no result line from claude").slice(0, 600);
    return {
      ok: false,
      reply: "",
      sessionId: s.sessionId,
      usage: null,
      costUsd: null,
      error: isConnectionDrop(reason)
        ? "network_error"
        : out.code === 0
          ? "prompt_invalid_response"
          : "prompt_failed",
      reason,
    };
  }
  if (s.isError) {
    const reason = (s.errorMessage ?? "claude reported is_error").slice(0, 600);
    return {
      ok: false,
      reply: s.resultText,
      sessionId: s.sessionId,
      usage: mapUsage(s.usage),
      costUsd: s.costUsd,
      error: isConnectionDrop(reason) ? "network_error" : "prompt_failed",
      reason,
    };
  }
  return {
    ok: true,
    reply: s.resultText || s.lastAssistantText,
    sessionId: s.sessionId,
    usage: mapUsage(s.usage),
    costUsd: s.costUsd,
  };
}

export async function runClaude(input: RunClaudeInput): Promise<RunClaudeResult> {
  await mkdir(input.cwd, { recursive: true }).catch(() => {});
  // Resume first so an ongoing thread is a single invocation; only the
  // first turn of a session pays the extra create attempt. A missing-session
  // resume exits before producing any assistant/tool output (num_turns=0),
  // so forwarding its (empty) event stream live is safe — no duplicates.
  const resumeOut = await spawnClaude(input, "resume", "stream-json", input.onEvent);
  if (
    !resumeOut.aborted &&
    !resumeOut.timedOut &&
    isMissingSession(resumeOut)
  ) {
    const createOut = await spawnClaude(input, "create", "stream-json", input.onEvent);
    // A retry can race the prior (failed) attempt: this resume saw no session
    // file yet and fell to create, but the session now exists ("already in
    // use"). The session is real, so resume it rather than fail — the
    // continuation OCCA wanted. Failed resume/create attempts exit at
    // num_turns=0 with no assistant output, so the extra spawns add no
    // duplicate events.
    if (
      !createOut.aborted &&
      !createOut.timedOut &&
      isSessionInUse(createOut)
    ) {
      return toResult(
        await spawnClaude(input, "resume", "stream-json", input.onEvent),
      );
    }
    return toResult(createOut);
  }
  return toResult(resumeOut);
}

// Cheap liveness check: confirms the `claude` binary is present and runs,
// without a real model round-trip. This is what the periodic connection
// probe uses — running a full inference (probeClaude) every 90s per agent
// would spawn claude constantly and burn tokens for nothing, and a cold or
// loaded `claude -p` routinely exceeds the probe's 10s budget, flapping the
// agent to a false "Disconnected". Mirrors the Hermes/OpenClaw probes, which
// only check transport reachability, not that the model can generate. Auth /
// "can actually infer" is validated on the first real task, same as them.
export async function claudeAvailable(): Promise<{
  ok: boolean;
  version?: string;
  error?: string;
  reason?: string;
}> {
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: {
      ok: boolean;
      version?: string;
      error?: string;
      reason?: string;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(CLAUDE_BIN, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        error: "gateway_unreachable",
        reason: "claude --version timed out",
      });
    }, 5_000);
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      finish({
        ok: false,
        error: "config_invalid",
        reason: `claude binary not found: ${err.message}`,
      });
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true, version: stdout.trim() || undefined });
      } else {
        finish({
          ok: false,
          error: "config_invalid",
          reason: (stderr || `claude --version exited ${code}`).slice(0, 200),
        });
      }
    });
  });
}

// One-shot reachability probe: confirms the binary runs and auth resolves.
// Uses plain `json` output (a single result object) — no event stream needed.
export async function probeClaude(model: string): Promise<{
  ok: boolean;
  error?: string;
  reason?: string;
}> {
  // Ensure the cwd exists before spawning — on a fresh box the workspace
  // root may not exist yet, and spawn() reports a missing cwd as ENOENT,
  // which would otherwise be misread as "claude binary not found".
  const cwd = process.env.OCCA_CLAUDE_WORKSPACE_ROOT ?? process.cwd();
  await mkdir(cwd, { recursive: true }).catch(() => {});
  const out = await spawnClaude(
    {
      prompt: "Reply with exactly: ok",
      cwd,
      model,
      // A fresh session id each probe — a deterministic one collides with
      // "Session ID already in use" on the second probe (the button can be
      // clicked repeatedly). Continuity is irrelevant for a one-shot probe.
      sessionUuid: randomUUID(),
      allowedTools: [],
      timeoutMs: 60_000,
    },
    "create",
    "json",
  );
  if (out.timedOut) {
    return {
      ok: false,
      error: "gateway_unreachable",
      reason: "claude did not respond within the probe window",
    };
  }
  if (out.code === null && /spawn_error|ENOENT/.test(out.rawStderr)) {
    return { ok: false, error: "config_invalid", reason: "claude binary not found" };
  }
  if (!out.state.sawResult) {
    return {
      ok: false,
      error: "gateway_unreachable",
      reason: (out.rawStderr || "no response from claude").slice(0, 300),
    };
  }
  if (out.state.isError && /login|not logged in|auth/i.test(out.state.errorMessage ?? "")) {
    return {
      ok: false,
      error: "gateway_unauthorized",
      reason: "claude is not logged in — set CLAUDE_CODE_OAUTH_TOKEN or run claude login",
    };
  }
  return { ok: true };
}
