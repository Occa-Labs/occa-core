// @occa/adapter-claude-code — Claude Code runtime adapter
//
// Drives Claude Code (`claude -p`) as a local subprocess. Each agent gets
// an isolated workspace directory; OCCA's persona + skills are seeded as
// files (Claude Code auto-loads CLAUDE.md), and each turn is one `claude
// -p` invocation with JSON output. Conversation continuity rides on Claude
// Code's own session store via a deterministic session id.
//
// Auth is subscription-based: CLAUDE_CODE_OAUTH_TOKEN (from `claude
// setup-token`) on a server, or the interactive login on a dev machine.
// The adapter never handles the token — it inherits the process env.

import { rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentAdapter,
  AdapterDeprovisionInput,
  AdapterProvisionInput,
  AdapterProvisionResult,
  AdapterResetSessionInput,
  AdapterResetSessionResult,
  AdapterSeedInput,
  AdapterSeedResult,
  AdapterSendPromptInput,
  AdapterSendPromptResult,
  AdapterTraceResult,
  AdapterExecutionContext,
  AssignedSkill,
  LivenessState,
  PrepareCredentialsResult,
  ProbeResult,
  WorkspaceFile,
} from "@occa/runtime-core";
import { buildWakeText } from "@occa/runtime-core";

import {
  runClaude,
  probeClaude,
  sessionUuidFromKey,
  type RunClaudeResult,
} from "./claude-cli";
import { parseConfig, workspacePathFor } from "./types";

export type { ClaudeCodeAdapterConfig } from "./types";

// Tools a task-mode agent may use. Chat (sendPrompt) passes none. Kept
// conservative — no MCP, no subagent spawning (headless can't approve).
const TASK_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"];

// Assemble OCCA's persona + skills into a CLAUDE.md so Claude Code loads
// the agent's identity automatically at session start (cached on its side
// across turns). Individual files are also written verbatim so the agent
// can read_file them by name if a skill references one.
function buildClaudeMd(files: WorkspaceFile[], skills: AssignedSkill[]): string {
  const lines: string[] = [
    "# Agent context (managed by OCCA — do not edit)",
    "",
    "Your identity, team awareness, and operating notes are below. Treat",
    "them as authoritative.",
  ];
  for (const f of files) {
    lines.push("", `## ${f.filename}`, "", f.content.trim());
  }
  if (skills.length > 0) {
    lines.push("", "# Assigned skills");
    for (const s of skills) {
      const desc = s.description ? ` — ${s.description}` : "";
      lines.push("", `## skill: ${s.key} (${s.name})${desc}`, "", s.markdown.trim());
    }
  }
  return lines.join("\n");
}

async function seedFiles(
  workspacePath: string,
  files: WorkspaceFile[],
  skills: AssignedSkill[],
): Promise<number> {
  await mkdir(workspacePath, { recursive: true });
  let pushed = 0;
  // CLAUDE.md = auto-loaded identity bundle.
  await writeFile(join(workspacePath, "CLAUDE.md"), buildClaudeMd(files, skills), "utf8");
  pushed += 1;
  // Verbatim copies for by-name reads.
  for (const f of files) {
    // Guard against path traversal in filenames.
    if (f.filename.includes("/") || f.filename.includes("..")) continue;
    await writeFile(join(workspacePath, f.filename), f.content, "utf8");
    pushed += 1;
  }
  return pushed;
}

function toTraceUsage(usage: RunClaudeResult["usage"], costUsd: number | null) {
  if (!usage) return null;
  return {
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
    cachedTokensIn: usage.cachedTokensIn,
    costCents: costUsd != null ? Math.round(costUsd * 100) : 0,
  };
}

function buildTraceSystemPrompt(ctx: AdapterExecutionContext): string {
  const { runtimeEnv } = ctx;
  // Persona + skills live in the seeded CLAUDE.md; keep this small so it
  // doesn't bloat every turn's input. Only the OCCA back-channel + the
  // kanban marker contract go here.
  return [
    "OCCA runtime:",
    `  apiUrl: ${runtimeEnv.apiUrl}`,
    `  apiKey: ${runtimeEnv.apiKey}`,
    `  agentId: ${runtimeEnv.agentId}`,
    `  traceId: ${runtimeEnv.traceId}`,
    "",
    "Task status (kanban):",
    "  - default: task auto-moves to `done` when you finish this run",
    "  - to request human review first, include the literal marker",
    "    `[[OCCA:REVIEW]]` anywhere in your reply.",
  ].join("\n");
}

export const claudeCodeAdapter: AgentAdapter = {
  type: "claude-code",
  // Claude Code keeps per-session conversation history on its own side
  // (resumed by session id), so OCCA sends only the new turn — same model
  // as openclaw / hermes.
  sessionMemory: "preserved",

  async probeConnection(config): Promise<ProbeResult> {
    const cfg = parseConfig(config as Record<string, unknown>);
    const started = Date.now();
    const res = await probeClaude(cfg.model);
    return {
      ok: res.ok,
      latencyMs: Date.now() - started,
      error: res.ok ? undefined : res.error,
      info: res.reason ? { message: res.reason } : undefined,
    };
  },

  async prepareCredentials(baseConfig): Promise<PrepareCredentialsResult> {
    const cfg = parseConfig(baseConfig as Record<string, unknown>);
    const res = await probeClaude(cfg.model);
    if (!res.ok) {
      return { ok: false, error: res.error ?? "probe_failed", reason: res.reason };
    }
    return { ok: true, configPatch: {} };
  },

  async provision(input: AdapterProvisionInput): Promise<AdapterProvisionResult> {
    const workspacePath = workspacePathFor(input.desiredExternalId);
    await mkdir(workspacePath, { recursive: true });
    return {
      ok: true,
      externalAgentId: input.desiredExternalId,
      workspacePath,
      configPatch: {},
    };
  },

  async deprovision(input: AdapterDeprovisionInput): Promise<void> {
    // Best-effort: remove the agent's local workspace (+ its Claude
    // sessions live in ~/.claude keyed by cwd, so they're orphaned, not
    // leaked). Never throws — callers treat cleanup as non-fatal.
    try {
      await rm(workspacePathFor(input.externalAgentId), {
        recursive: true,
        force: true,
      });
    } catch {
      /* ignore */
    }
  },

  async seedWorkspace(input: AdapterSeedInput): Promise<AdapterSeedResult> {
    try {
      const workspacePath = workspacePathFor(input.externalAgentId);
      const files: WorkspaceFile[] = input.files;
      const pushed = await seedFiles(workspacePath, files, []);
      return { ok: true, pushed };
    } catch (err) {
      return {
        ok: false,
        error: "seed_failed",
        reason: err instanceof Error ? err.message : "workspace seed failed",
      };
    }
  },

  async sendPrompt(
    input: AdapterSendPromptInput,
  ): Promise<AdapterSendPromptResult> {
    const cfg = parseConfig(input.adapterConfig);
    const workspacePath = workspacePathFor(input.externalAgentId);
    const result = await runClaude({
      prompt: input.message,
      cwd: workspacePath,
      model: cfg.model,
      sessionUuid: sessionUuidFromKey(input.sessionKey),
      // Chat = text only. No tools so a conversational agent can't shell
      // out and a permission prompt never hangs.
      allowedTools: [],
      timeoutMs: input.waitTimeoutMs,
    });
    if (!result.ok) {
      input.onEvent?.("error", { error: result.error, reason: result.reason });
      return { ok: false, error: result.error ?? "prompt_failed", reason: result.reason };
    }
    if (input.onEvent && result.reply) {
      input.onEvent("assistant", { delta: result.reply });
    }
    return { ok: true, reply: result.reply };
  },

  async executeTrace(ctx: AdapterExecutionContext): Promise<AdapterTraceResult> {
    const cfg = parseConfig(ctx.adapterConfig);
    const { payload, sessionParams } = ctx;
    // runtimeEnv.agentId IS the external (adapter-side) agent id.
    const workspacePath = workspacePathFor(ctx.runtimeEnv.agentId);

    // Refresh the seeded identity for this run so persona/skill edits in
    // OCCA show up without a redeploy.
    try {
      await seedFiles(workspacePath, ctx.workspaceFiles, ctx.skills);
    } catch {
      /* non-fatal — stale files still work */
    }

    const wakeText = buildWakeText(payload, {
      agentName: (sessionParams?.agentName as string) ?? "agent",
      taskTitle: sessionParams?.taskTitle as string | undefined,
      taskDescription: sessionParams?.taskDescription as string | undefined,
      routineTitle: sessionParams?.routineTitle as string | undefined,
      routineMandate: sessionParams?.routineMandate as string | undefined,
      subordinates: sessionParams?.subordinates as
        | { id: string; name: string; role: string }[]
        | undefined,
      recentCoverage: sessionParams?.recentCoverage as
        | { date: string; category: string; title: string }[]
        | undefined,
    });

    const explicitSessionKey =
      sessionParams && typeof sessionParams.sessionKey === "string"
        ? (sessionParams.sessionKey as string)
        : null;
    const sessionKey =
      explicitSessionKey ??
      `agent:${ctx.runtimeEnv.agentId}:task:${payload.taskId ?? payload.traceId}`;

    const result = await runClaude({
      prompt: wakeText,
      cwd: workspacePath,
      model: cfg.model,
      sessionUuid: sessionUuidFromKey(sessionKey),
      appendSystemPrompt: buildTraceSystemPrompt(ctx),
      allowedTools: TASK_TOOLS,
      signal: ctx.signal,
    });

    if (!result.ok) {
      const cancelled = result.error === "cancelled";
      return {
        outcome: cancelled ? "cancelled" : "failed",
        livenessState: null,
        usage: toTraceUsage(result.usage, result.costUsd),
        error: {
          code: result.error ?? "prompt_failed",
          message: result.reason ?? "claude run failed",
        },
        sessionIdAfter: result.sessionId,
        resultJson: result.reply ? { text: result.reply } : null,
      };
    }

    const summary = result.reply.trim();
    if (summary) {
      ctx.onEvent({ type: "assistant.message", stream: "stdout", message: summary });
    }
    const liveness: LivenessState = summary ? "normal" : "empty_response";
    ctx.onLivenessHint(liveness);

    return {
      outcome: "succeeded",
      livenessState: liveness,
      usage: toTraceUsage(result.usage, result.costUsd),
      error: null,
      sessionIdAfter: result.sessionId,
      resultJson: { text: summary },
    };
  },

  async resetSession(
    _input: AdapterResetSessionInput,
  ): Promise<AdapterResetSessionResult> {
    // Continuity is keyed by the OCCA sessionKey → deterministic Claude
    // session id. A thread clear bumps resetGeneration in the sessionKey,
    // which yields a brand-new Claude session id on the next turn, so the
    // old conversation is naturally abandoned. Nothing to wipe here.
    return { ok: true };
  },
};
