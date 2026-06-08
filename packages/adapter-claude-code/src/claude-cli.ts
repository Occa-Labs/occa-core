// Thin wrapper around the `claude` CLI in print mode (`claude -p`). The
// adapter drives Claude Code as a local subprocess: one invocation per
// turn, JSON output parsed for the reply + usage. Conversation continuity
// rides on Claude Code's own session store via a deterministic session id
// derived from OCCA's sessionKey (resume-first, create-on-miss).
//
// Auth is inherited from the process environment — CLAUDE_CODE_OAUTH_TOKEN
// (from `claude setup-token`, a Pro/Max subscription) on a server, or the
// interactive login on a dev machine. The adapter never handles the token.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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

interface ClaudeJson {
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
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
  signal?: AbortSignal;
  timeoutMs?: number;
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

interface SpawnOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
}

function spawnClaude(
  input: RunClaudeInput,
  mode: "resume" | "create",
): Promise<SpawnOutput> {
  const args = ["-p", "--output-format", "json", "--model", input.model];
  if (mode === "resume") args.push("--resume", input.sessionUuid);
  else args.push("--session-id", input.sessionUuid);
  if (input.appendSystemPrompt && input.appendSystemPrompt.length > 0) {
    args.push("--append-system-prompt", input.appendSystemPrompt);
  }
  if (input.allowedTools && input.allowedTools.length > 0) {
    args.push("--allowedTools", input.allowedTools.join(","));
  } else {
    // Pure conversational turn — deny every tool so a chat agent can't
    // shell out, and so a missing-permission prompt never hangs headless.
    args.push("--allowedTools", "");
  }

  return new Promise<SpawnOutput>((resolve) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let aborted = false;

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
          aborted = true;
          child.kill("SIGTERM");
        }, input.timeoutMs)
      : null;

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      stderr += `\nspawn_error: ${err instanceof Error ? err.message : String(err)}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));

    function finish(code: number | null) {
      if (timer) clearTimeout(timer);
      if (input.signal) input.signal.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, aborted });
    }

    // Prompt over stdin avoids ARG_MAX limits on long wake text.
    child.stdin.write(input.prompt);
    child.stdin.end();
  });
}

function tryParse(stdout: string): ClaudeJson | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ClaudeJson;
  } catch {
    return null;
  }
}

// A resume against an unknown session id — fall back to creating it.
function isMissingSession(out: SpawnOutput, parsed: ClaudeJson | null): boolean {
  const hay = `${out.stderr} ${parsed?.result ?? ""}`.toLowerCase();
  return (
    /no conversation|no session|session .*not found|not found.*session|unknown session/.test(
      hay,
    ) || (out.code !== 0 && /resume|session/.test(hay))
  );
}

function toResult(out: SpawnOutput, parsed: ClaudeJson | null): RunClaudeResult {
  if (out.aborted) {
    return {
      ok: false,
      reply: "",
      sessionId: null,
      usage: null,
      costUsd: null,
      error: "cancelled",
      reason: "run aborted",
    };
  }
  if (!parsed) {
    return {
      ok: false,
      reply: "",
      sessionId: null,
      usage: null,
      costUsd: null,
      error: out.code === 0 ? "prompt_invalid_response" : "prompt_failed",
      reason: (out.stderr || "no parseable JSON from claude").slice(0, 600),
    };
  }
  if (parsed.is_error) {
    return {
      ok: false,
      reply: parsed.result ?? "",
      sessionId: parsed.session_id ?? null,
      usage: null,
      costUsd: parsed.total_cost_usd ?? null,
      error: "prompt_failed",
      reason: (parsed.result ?? out.stderr ?? "claude reported is_error").slice(0, 600),
    };
  }
  return {
    ok: true,
    reply: parsed.result ?? "",
    sessionId: parsed.session_id ?? null,
    usage: parsed.usage
      ? {
          inputTokens: parsed.usage.input_tokens ?? 0,
          outputTokens: parsed.usage.output_tokens ?? 0,
          cachedTokensIn: parsed.usage.cache_read_input_tokens ?? 0,
        }
      : null,
    costUsd: parsed.total_cost_usd ?? null,
  };
}

export async function runClaude(input: RunClaudeInput): Promise<RunClaudeResult> {
  await mkdir(input.cwd, { recursive: true }).catch(() => {});
  // Resume first so an ongoing thread is a single invocation; only the
  // first turn of a session pays the extra create attempt.
  const resumeOut = await spawnClaude(input, "resume");
  const resumeParsed = tryParse(resumeOut.stdout);
  if (!resumeOut.aborted && isMissingSession(resumeOut, resumeParsed)) {
    const createOut = await spawnClaude(input, "create");
    return toResult(createOut, tryParse(createOut.stdout));
  }
  return toResult(resumeOut, resumeParsed);
}

// One-shot reachability probe: confirms the binary runs and auth resolves.
export async function probeClaude(model: string): Promise<{
  ok: boolean;
  error?: string;
  reason?: string;
}> {
  const out = await spawnClaude(
    {
      prompt: "Reply with exactly: ok",
      cwd: process.env.OCCA_CLAUDE_WORKSPACE_ROOT ?? process.cwd(),
      model,
      sessionUuid: sessionUuidFromKey(`probe:${model}`),
      allowedTools: [],
      timeoutMs: 60_000,
    },
    "create",
  );
  const parsed = tryParse(out.stdout);
  if (out.code === null && /spawn_error|ENOENT/.test(out.stderr)) {
    return { ok: false, error: "config_invalid", reason: "claude binary not found" };
  }
  if (!parsed) {
    return {
      ok: false,
      error: "gateway_unreachable",
      reason: (out.stderr || "no response from claude").slice(0, 300),
    };
  }
  if (parsed.is_error && /login|not logged in|auth/i.test(parsed.result ?? "")) {
    return {
      ok: false,
      error: "gateway_unauthorized",
      reason: "claude is not logged in — set CLAUDE_CODE_OAUTH_TOKEN or run claude login",
    };
  }
  return { ok: true };
}
