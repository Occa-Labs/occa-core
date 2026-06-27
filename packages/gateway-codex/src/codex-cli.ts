// Thin wrapper around the `codex` CLI in exec mode (`codex exec --json`).
// Drives Codex as a local subprocess: one invocation per turn. `--json` makes
// stdout a JSONL event stream (thread.started / turn.started / item.* /
// turn.completed) which we parse into the normalized CodexStreamEvent shape and
// fold into a final RunCodexResult.
//
// Session continuity: codex has NO flag to set a session id, so we can't derive
// one from the sessionKey the way the Claude Gateway does. Instead we capture
// the `thread_id` codex emits in `thread.started` on the first turn, persist a
// `sessionKey → thread_id` map in the agent workspace, and resume later turns
// with `codex exec resume <thread_id>`. A stale id (rollout gone) falls back to
// a fresh create.
//
// Auth is inherited from the process environment — OPENAI_API_KEY or a
// `codex login` ChatGPT session on the box. This module never handles it.
//
// Verified against codex-cli 0.142.3 (see PHASE2-REFERENCE.md). OCCA-neutral:
// node builtins only.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CodexStreamEvent, RunCodexInput, RunCodexResult } from "./wire";

export type { CodexStreamEvent, RunCodexInput, RunCodexResult } from "./wire";

// Binary path override for hosts where `codex` isn't on the service PATH.
const CODEX_BIN = process.env.OCCA_CODEX_BIN ?? "codex";

// Per-agent sessionKey → thread_id map, stored in the agent's workspace so it
// is wiped when the workspace is deprovisioned.
const STORE_FILE = ".occa-codex-sessions.json";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

async function readSessionMap(cwd: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(cwd, STORE_FILE), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

async function writeThreadId(cwd: string, sessionKey: string, threadId: string): Promise<void> {
  // Read-modify-write so concurrent sessionKeys in the same workspace don't
  // clobber each other's ids. The server serializes turns per sessionKey, so
  // only cross-key writes race here, and they're rare.
  const map = await readSessionMap(cwd);
  if (map[sessionKey] === threadId) return;
  map[sessionKey] = threadId;
  await writeFile(join(cwd, STORE_FILE), `${JSON.stringify(map, null, 2)}\n`, "utf8");
}

// codex exec --json usage object (turn.completed.usage).
interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

// Mutable accumulator filled as JSONL lines stream in.
interface StreamState {
  sessionId: string | null; // codex thread_id from thread.started
  lastAssistantText: string;
  usage: CodexUsage | null;
  isError: boolean;
  errorMessage: string | null;
  sawTurnCompleted: boolean;
}

function newStreamState(): StreamState {
  return {
    sessionId: null,
    lastAssistantText: "",
    usage: null,
    isError: false,
    errorMessage: null,
    sawTurnCompleted: false,
  };
}

// Route one parsed JSONL line into the accumulator and emit live events.
// Codex event schema verified on 0.142.3:
//   {"type":"thread.started","thread_id":"<uuid>"}
//   {"type":"turn.started"}
//   {"type":"item.started"|"item.completed","item":{id,type,...}}
//     item.type: agent_message {text} | command_execution {command,
//       aggregated_output, exit_code, status} | file_change {changes[],status}
//   {"type":"turn.completed","usage":{input_tokens,cached_input_tokens,
//       output_tokens,reasoning_output_tokens}}
//   {"type":"turn.failed"} | {"type":"error","message"}
function handleLine(
  obj: Record<string, unknown>,
  state: StreamState,
  onEvent?: (event: CodexStreamEvent) => void,
): void {
  const type = asString(obj.type);

  if (type === "thread.started") {
    const tid = asString(obj.thread_id);
    if (tid) state.sessionId = tid;
    return;
  }

  if (type === "turn.completed") {
    state.sawTurnCompleted = true;
    const usage = asRecord(obj.usage);
    if (usage) state.usage = usage as CodexUsage;
    return;
  }

  if (type === "turn.failed") {
    state.isError = true;
    const err = asRecord(obj.error);
    state.errorMessage = asString(err?.message) ?? asString(obj.error) ?? "codex turn failed";
    return;
  }

  if (type === "error") {
    state.isError = true;
    state.errorMessage = asString(obj.message) ?? "codex error";
    return;
  }

  if (type === "item.started" || type === "item.completed") {
    const item = asRecord(obj.item);
    if (!item) return;
    const itemType = asString(item.type);
    const done = type === "item.completed";

    if (itemType === "agent_message") {
      if (done) {
        const text = asString(item.text);
        if (text) {
          state.lastAssistantText = text;
          onEvent?.({ kind: "assistant_text", text });
        }
      }
    } else if (itemType === "command_execution") {
      if (!done) {
        onEvent?.({ kind: "tool_use", toolName: "command", toolInput: item.command });
      } else {
        const out = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
        const exit = item.exit_code;
        onEvent?.({
          kind: "tool_result",
          toolResult: out.slice(0, 2000),
          isError: typeof exit === "number" && exit !== 0,
        });
      }
    } else if (itemType === "file_change") {
      if (!done) {
        onEvent?.({ kind: "tool_use", toolName: "file_change", toolInput: item.changes });
      } else {
        onEvent?.({
          kind: "tool_result",
          toolResult: JSON.stringify(item.changes ?? []).slice(0, 2000),
          isError: false,
        });
      }
    }
    // Other item types (reasoning, mcp tool calls, …) are not surfaced.
    return;
  }
}

interface SpawnOutput {
  code: number | null;
  rawStderr: string;
  state: StreamState;
  aborted: boolean;
  timedOut: boolean;
}

// codex's stdout JSONL is authoritative; stderr is logs. One known-benign line
// ("failed to refresh available models") shows up on every run — strip it so a
// failure `reason` isn't drowned in noise.
function cleanStderr(s: string): string {
  return s
    .split("\n")
    .filter((l) => !/failed to refresh available models/i.test(l))
    .join("\n")
    .trim();
}

function sandboxFor(input: RunCodexInput): "workspace-write" | "read-only" {
  // The wire carries claude-style tool lists; codex has no per-tool flags, so
  // a non-empty allowlist (any work session) maps to a write-capable sandbox
  // and an empty one (chat) to read-only. sessionKey ↔ mode is stable across a
  // session's turns, so resume inherits the same mode via -c sandbox_mode.
  return input.allowedTools && input.allowedTools.length > 0
    ? "workspace-write"
    : "read-only";
}

function spawnCodex(
  input: RunCodexInput,
  mode: "create" | "resume",
  threadId: string | null,
  onEvent?: (event: CodexStreamEvent) => void,
): Promise<SpawnOutput> {
  const sandbox = sandboxFor(input);
  const args = ["exec"];
  if (mode === "resume" && threadId) args.push("resume", threadId);
  args.push("--json", "--skip-git-repo-check", "-m", input.model);
  // `codex exec` takes -s; `codex exec resume` does NOT (rejects it) — set the
  // sandbox there via a config override instead (verified 0.142.3).
  if (mode === "resume") args.push("-c", `sandbox_mode=${sandbox}`);
  else args.push("-s", sandbox);
  // `-` reads the prompt from stdin (avoids ARG_MAX on long wake text).
  args.push("-");

  // Codex exec has no --append-system-prompt; fold the OCCA back-channel /
  // marker contract into the prompt as a leading block.
  const fullPrompt =
    input.appendSystemPrompt && input.appendSystemPrompt.length > 0
      ? `${input.appendSystemPrompt}\n\n---\n\n${input.prompt}`
      : input.prompt;

  return new Promise<SpawnOutput>((resolve) => {
    const child = spawn(CODEX_BIN, args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const state = newStreamState();
    let rawStderr = "";
    let lineBuf = "";
    let aborted = false;
    let timedOut = false;

    const routeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj: Record<string, unknown> | null = null;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return; // non-JSON stdout line — ignore (codex prints only JSONL here)
      }
      if (obj) handleLine(obj, state, onEvent);
    };
    const consume = (chunk: string) => {
      lineBuf += chunk;
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) >= 0) {
        routeLine(lineBuf.slice(0, idx));
        lineBuf = lineBuf.slice(idx + 1);
      }
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

    child.stdout.on("data", (d) => consume(d.toString()));
    child.stderr.on("data", (d) => (rawStderr += d.toString()));
    child.on("error", (err) => {
      rawStderr += `\nspawn_error: ${err instanceof Error ? err.message : String(err)}`;
      finish(null);
    });
    child.on("close", (code) => {
      if (lineBuf.trim()) routeLine(lineBuf);
      finish(code);
    });

    function finish(code: number | null) {
      if (timer) clearTimeout(timer);
      if (input.signal) input.signal.removeEventListener("abort", onAbort);
      resolve({ code, rawStderr, state, aborted, timedOut });
    }

    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}

// A resume against an id whose rollout no longer exists. Verified error text on
// 0.142.3: "thread/resume failed: no rollout found for thread id <id>".
function isMissingSession(out: SpawnOutput): boolean {
  const hay = `${out.rawStderr} ${out.state.errorMessage ?? ""}`.toLowerCase();
  return /no rollout found for thread|thread\/resume failed/.test(hay);
}

function isConnectionDrop(text: string): boolean {
  return /socket (connection|hang)|connection (closed|reset|refused|error)|network error|econn(reset|refused|aborted)|etimedout|fetch failed|premature close|stream (closed|disconnected|error)/i.test(
    text,
  );
}

function mapUsage(usage: CodexUsage | null): RunCodexResult["usage"] {
  if (!usage) return null;
  // codex `input_tokens` is the TOTAL prompt count and INCLUDES the cached
  // subset. OCCA's `inputTokens` is the fresh (non-cached) input — the billed
  // bucket — kept disjoint from `cachedTokensIn`. Subtract so the two don't
  // double-count.
  const total = asNum(usage.input_tokens);
  const cached = asNum(usage.cached_input_tokens);
  return {
    inputTokens: Math.max(0, total - cached),
    outputTokens: asNum(usage.output_tokens),
    cachedTokensIn: cached,
  };
}

function toResult(out: SpawnOutput): RunCodexResult {
  if (out.timedOut) {
    return errResult(out.state.sessionId, "timeout", "codex run exceeded timeout");
  }
  if (out.aborted) {
    return errResult(out.state.sessionId, "cancelled", "run aborted");
  }
  const s = out.state;
  if (s.isError) {
    const reason = (s.errorMessage ?? "codex reported an error").slice(0, 600);
    return {
      ok: false,
      reply: s.lastAssistantText,
      sessionId: s.sessionId,
      usage: mapUsage(s.usage),
      costUsd: null,
      error: isConnectionDrop(reason) ? "network_error" : "prompt_failed",
      reason,
    };
  }
  if (!s.sawTurnCompleted) {
    const reason = (cleanStderr(out.rawStderr) || "no turn.completed from codex").slice(0, 600);
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
  return {
    ok: true,
    reply: s.lastAssistantText,
    sessionId: s.sessionId,
    usage: mapUsage(s.usage),
    costUsd: null,
  };
}

function errResult(
  sessionId: string | null,
  error: string,
  reason: string,
): RunCodexResult {
  return { ok: false, reply: "", sessionId, usage: null, costUsd: null, error, reason };
}

export async function runCodex(input: RunCodexInput): Promise<RunCodexResult> {
  await mkdir(input.cwd, { recursive: true }).catch(() => {});

  const map = await readSessionMap(input.cwd);
  const priorThreadId = map[input.sessionKey] ?? null;

  if (priorThreadId) {
    const resumed = await spawnCodex(input, "resume", priorThreadId, input.onEvent);
    if (!resumed.aborted && !resumed.timedOut && isMissingSession(resumed)) {
      // Stale id — the rollout is gone. Start a fresh thread and remap.
      const created = await spawnCodex(input, "create", null, input.onEvent);
      await persistThread(input, created);
      return toResult(created);
    }
    return toResult(resumed);
  }

  const created = await spawnCodex(input, "create", null, input.onEvent);
  await persistThread(input, created);
  return toResult(created);
}

// Persist the codex thread_id under the sessionKey so the next turn resumes it.
// Only on a non-aborted run that actually produced an id.
async function persistThread(input: RunCodexInput, out: SpawnOutput): Promise<void> {
  if (out.aborted || out.timedOut) return;
  if (!out.state.sessionId) return;
  await writeThreadId(input.cwd, input.sessionKey, out.state.sessionId).catch(() => {});
}

// Cheap liveness check: confirms the `codex` binary is present and runs,
// without a model round-trip. The connection probe hits this every ~90s per
// agent, so a real `codex exec` here would burn quota and flap on slow spawns.
// Auth / "can actually infer" is validated on the first real task (parity with
// the Claude/Hermes/OpenClaw probes).
export async function codexAvailable(): Promise<{
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
    const child = spawn(CODEX_BIN, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, error: "gateway_unreachable", reason: "codex --version timed out" });
    }, 5_000);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => {
      finish({ ok: false, error: "config_invalid", reason: `codex binary not found: ${err.message}` });
    });
    child.on("close", (code) => {
      if (code === 0) finish({ ok: true, version: stdout.trim() || undefined });
      else
        finish({
          ok: false,
          error: "config_invalid",
          reason: (stderr || `codex --version exited ${code}`).slice(0, 200),
        });
    });
  });
}
