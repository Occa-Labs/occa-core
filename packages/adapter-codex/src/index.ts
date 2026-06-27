// @occa/adapter-codex — Codex CLI runtime adapter (gateway-only)
//
// codex is a BYORT runtime: someone hosts OpenAI's Codex CLI on their own box
// and OCCA reaches it over HTTP, exactly like the openclaw / hermes /
// claude-code adapters. The adapter NEVER spawns codex itself — OCCA runs on
// OCCA's servers and can't be co-located with a third party's Codex login.
// Every call goes to a Codex Gateway (the @occa/gateway-codex service, Phase
// 2) addressed by `gatewayUrl` + `apiKey`. For local dev you point at a
// gateway on `localhost`.
//
// Each agent gets an isolated workspace on the gateway box; OCCA's persona +
// skills are assembled into an AGENTS.md (Codex auto-loads it) and shipped to
// the gateway to write. Continuity rides on Codex's own rollout-based session
// store (`codex exec resume`). Unlike Claude Code, codex has no settable
// session id, so the gateway maps OCCA's sessionKey → the `thread_id` it
// captures from the first turn's `thread.started` event (see PHASE2-REFERENCE).
//
// All the ways Codex differs from Claude Code — the `codex exec --json` event
// schema, the sandbox + approval permission model (no per-tool allow/deny),
// the lack of a per-run USD cap — are absorbed by the GATEWAY, not here. This
// adapter speaks the same uniform wire as claude-code so the OCCA core and the
// trace feed stay runtime-agnostic.

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

import type { CodexStreamEvent, RunCodexResult } from "@occa/gateway-codex/wire";
import { parseConfig, type CodexAdapterConfig } from "./types";
import {
  gatewayHealth,
  gatewaySeed,
  gatewayDeprovision,
  gatewayRun,
  type GatewayTarget,
} from "./gateway-client";

export type { CodexAdapterConfig } from "./types";

// codex has no local mode in OCCA — a gateway is mandatory.
const MISSING_GATEWAY = "codex requires a gateway URL and bearer";

// Resolve the gateway target, or null when the config has no gateway (which
// every method then surfaces as a config_invalid error).
function targetFor(cfg: CodexAdapterConfig): GatewayTarget | null {
  return cfg.gatewayUrl ? { gatewayUrl: cfg.gatewayUrl, apiKey: cfg.apiKey } : null;
}

// Tools a task-mode agent may use. The gateway maps a NON-empty list to a
// write-capable codex sandbox (`--sandbox workspace-write`); the specific
// names are advisory (codex has no per-tool allowlist), but kept for parity
// with the other adapters and so the wire frame is identical across runtimes.
const TASK_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"];

// Always blocked on a task run: subagent spawning bypasses OCCA's task board +
// gate. Codex doesn't spawn OCCA-style sub-agents, but the denylist is sent so
// the gateway's policy decision matches claude-code's.
const TASK_DENY = ["Task"];

// Hard deny for a conversational turn. Paired with an empty allowlist so the
// gateway drops codex into a read-only, no-approval sandbox and the chat stays
// strictly text-only even on a host whose config pre-approves tools.
const CHAT_DENY = [...TASK_TOOLS, "Task", "Workflow", "Skill"];

// Internal ceiling for a single task run. One `codex exec` invocation drives
// the agent's entire multi-turn loop, so it can legitimately run long — but it
// must still be bounded so a runaway tool loop can't pin the worker. The
// dispatcher's AbortSignal is the outer cancel; this is the adapter-side
// backstop, mapping to a `timed_out` outcome. 20 min. Codex has no per-run USD
// cap, so this wall-clock bound (plus the monthly treasury gate at dispatch)
// is what keeps cost predictable.
const TASK_TIMEOUT_MS = 1_200_000;

// Assemble OCCA's persona + skills into an AGENTS.md so Codex loads the
// agent's identity automatically at session start. Individual files are also
// shipped verbatim so the agent can read them by name if a skill references
// one.
function buildAgentsMd(files: WorkspaceFile[], skills: AssignedSkill[]): string {
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
    lines.push(
      "",
      "# Assigned skills",
      "",
      "Full content below — read before acting.",
      "",
      "Auxiliary lookups (only if you need extra files for a multi-file skill):",
      "  GET {apiUrl}/api/me/agent/skills/{urlEncodedKey}/files/{path}",
    );
    for (const s of skills) {
      const desc = s.description ? ` — ${s.description}` : "";
      lines.push(
        "",
        `## skill: ${s.key} (slug: ${s.slug}, name: ${s.name})${desc}`,
        "",
        s.markdown.trim(),
      );
    }
  }
  return lines.join("\n");
}

// The flat file list shipped to the gateway: the assembled AGENTS.md identity
// bundle plus verbatim copies of each workspace file. The gateway writes them
// into the agent's workspace on its box.
function buildSeedFileList(
  files: WorkspaceFile[],
  skills: AssignedSkill[],
): Array<{ filename: string; content: string }> {
  const out: Array<{ filename: string; content: string }> = [
    { filename: "AGENTS.md", content: buildAgentsMd(files, skills) },
  ];
  for (const f of files) {
    // Guard against path traversal in filenames.
    if (f.filename.includes("/") || f.filename.includes("..")) continue;
    out.push({ filename: f.filename, content: f.content });
  }
  return out;
}

function toTraceUsage(usage: RunCodexResult["usage"], costUsd: number | null) {
  if (!usage) return null;
  return {
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
    cachedTokensIn: usage.cachedTokensIn,
    costCents: costUsd != null ? Math.round(costUsd * 100) : 0,
  };
}

// Map normalized stream events onto OCCA's AdapterTraceEvent for the WORKER
// executeTrace path. These land in the trace history view (rendered by
// eventType + payload). AdapterTraceEvent.stream is stdout/stderr only, so
// tool identity rides in `type` + `payload`, not a custom stream value.
function forwardRunEvent(
  onEvent: AdapterExecutionContext["onEvent"],
): (ev: CodexStreamEvent) => void {
  return (ev) => {
    if (ev.kind === "tool_use") {
      onEvent({
        type: "tool_use",
        message: ev.toolName,
        payload: { name: ev.toolName, input: ev.toolInput },
      });
    } else if (ev.kind === "tool_result") {
      onEvent({
        type: "tool_result",
        payload: { result: ev.toolResult, isError: ev.isError },
      });
    } else if (ev.kind === "error") {
      onEvent({
        type: "error",
        level: "error",
        message: ev.text,
        payload: { error: ev.text },
      });
    }
    // assistant_text intentionally dropped — see executeTrace.
  };
}

// Map normalized stream events onto the sendPrompt `(stream, data)` callback
// for the SERVER dispatcher path. Here `stream` is an unconstrained string,
// and the web LiveTraceFeed switches on it: `tool_call` → tool row (reads
// data.name + data.input), `error` → error row.
function forwardSendEvent(
  onEvent: NonNullable<AdapterSendPromptInput["onEvent"]>,
): (ev: CodexStreamEvent) => void {
  return (ev) => {
    if (ev.kind === "tool_use") {
      onEvent("tool_call", { name: ev.toolName, input: ev.toolInput });
    } else if (ev.kind === "tool_result") {
      onEvent("tool_result", { result: ev.toolResult, isError: ev.isError });
    } else if (ev.kind === "error") {
      onEvent("error", { error: ev.text });
    }
    // assistant_text dropped — the final reply is emitted once by the caller.
  };
}

function buildTraceSystemPrompt(ctx: AdapterExecutionContext): string {
  const { runtimeEnv } = ctx;
  // Persona + skills live in the seeded AGENTS.md; keep this small so it
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

export const codexAdapter: AgentAdapter = {
  type: "codex",
  // Codex keeps per-session conversation history on its own side (resumed by
  // rollout id), so OCCA sends only the new turn — same model as the other
  // gateway adapters.
  sessionMemory: "preserved",

  async probeConnection(config): Promise<ProbeResult> {
    const cfg = parseConfig(config as Record<string, unknown>);
    const target = targetFor(cfg);
    if (!target) {
      return { ok: false, latencyMs: 0, error: "config_invalid", info: { message: MISSING_GATEWAY } };
    }
    const started = Date.now();
    const res = await gatewayHealth(target);
    return {
      ok: res.ok,
      latencyMs: Date.now() - started,
      error: res.ok ? undefined : res.error,
      info: res.reason ? { message: res.reason } : undefined,
    };
  },

  async prepareCredentials(baseConfig): Promise<PrepareCredentialsResult> {
    const cfg = parseConfig(baseConfig as Record<string, unknown>);
    const target = targetFor(cfg);
    if (!target) {
      return { ok: false, error: "config_invalid", reason: MISSING_GATEWAY };
    }
    const res = await gatewayHealth(target);
    if (!res.ok) {
      return { ok: false, error: res.error ?? "probe_failed", reason: res.reason };
    }
    return { ok: true, configPatch: {} };
  },

  async provision(input: AdapterProvisionInput): Promise<AdapterProvisionResult> {
    // No local workspace to create — the gateway mkdirs the agent's workspace
    // on first seed/run. workspacePath is informational only (the conventional
    // path on the gateway box).
    return {
      ok: true,
      externalAgentId: input.desiredExternalId,
      workspacePath: `~/.occa-codex-agents/${input.desiredExternalId}`,
      configPatch: {},
    };
  },

  async deprovision(input: AdapterDeprovisionInput): Promise<void> {
    // Best-effort cleanup on the gateway box — never throws.
    const cfg = parseConfig(input.adapterConfig);
    const target = targetFor(cfg);
    if (target) await gatewayDeprovision(target, input.externalAgentId);
  },

  async seedWorkspace(input: AdapterSeedInput): Promise<AdapterSeedResult> {
    const cfg = parseConfig(input.adapterConfig);
    const target = targetFor(cfg);
    if (!target) {
      return { ok: false, error: "config_invalid", reason: MISSING_GATEWAY };
    }
    const res = await gatewaySeed(target, input.externalAgentId, buildSeedFileList(input.files, []));
    return res.ok
      ? { ok: true, pushed: res.pushed }
      : { ok: false, error: res.error ?? "seed_failed", reason: res.reason };
  },

  async sendPrompt(
    input: AdapterSendPromptInput,
  ): Promise<AdapterSendPromptResult> {
    const cfg = parseConfig(input.adapterConfig);
    const target = targetFor(cfg);
    if (!target) {
      input.onEvent?.("error", { error: "config_invalid", reason: MISSING_GATEWAY });
      return { ok: false, error: "config_invalid", reason: MISSING_GATEWAY };
    }
    // Conversational sessions (CEO chat `:chat:`, per-agent DM `:thread:`)
    // stay text-only so an agent can't shell out mid-chat and a missing
    // approval prompt never hangs headless. EVERY other session is real work
    // that needs the toolset — task dispatch (`:task:`), skill install
    // (`:skill:`), head review (`:review:`). Gate the inverse so a work
    // session never silently loses its tools.
    const isConversational =
      input.sessionKey.includes(":chat:") ||
      input.sessionKey.includes(":thread:");
    const useTools = !isConversational;
    // Stream tool activity to the live trace feed for task runs. Chat has no
    // tools, so this only ever carries an error event there.
    const onRunEvent = input.onEvent ? forwardSendEvent(input.onEvent) : undefined;
    const result = await gatewayRun(
      target,
      {
        externalAgentId: input.externalAgentId,
        prompt: input.message,
        model: cfg.model,
        sessionKey: input.sessionKey,
        allowedTools: useTools ? TASK_TOOLS : [],
        disallowedTools: useTools ? TASK_DENY : CHAT_DENY,
        timeoutMs: input.waitTimeoutMs ?? (useTools ? TASK_TIMEOUT_MS : undefined),
        // No per-run cost cap — spend is bounded by the company's monthly
        // budget gate at dispatch time + the wall-clock timeout (codex has no
        // USD cap flag), not by truncating a live run.
        maxBudgetUsd: input.maxBudgetUsd,
      },
      onRunEvent,
    );
    if (!result.ok) {
      input.onEvent?.("error", { error: result.error, reason: result.reason });
      return { ok: false, error: result.error ?? "prompt_failed", reason: result.reason };
    }
    if (input.onEvent && result.reply) {
      input.onEvent("assistant", { delta: result.reply });
    }
    return {
      ok: true,
      reply: result.reply,
      usage: toTraceUsage(result.usage, result.costUsd),
    };
  },

  async executeTrace(ctx: AdapterExecutionContext): Promise<AdapterTraceResult> {
    const cfg = parseConfig(ctx.adapterConfig);
    const target = targetFor(cfg);
    if (!target) {
      return {
        outcome: "failed",
        livenessState: null,
        usage: null,
        error: { code: "config_invalid", message: MISSING_GATEWAY },
        sessionIdAfter: null,
        resultJson: null,
      };
    }
    const { payload, sessionParams } = ctx;
    // runtimeEnv.agentId IS the external (adapter-side) agent id.
    const externalAgentId = ctx.runtimeEnv.agentId;

    // Refresh the seeded identity (persona + skills) on the gateway for this
    // run so OCCA edits show up without a redeploy. Non-fatal — stale files
    // still work.
    try {
      await gatewaySeed(target, externalAgentId, buildSeedFileList(ctx.workspaceFiles, ctx.skills));
    } catch {
      /* non-fatal */
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
    });

    const explicitSessionKey =
      sessionParams && typeof sessionParams.sessionKey === "string"
        ? (sessionParams.sessionKey as string)
        : null;
    const sessionKey =
      explicitSessionKey ??
      `agent:${ctx.runtimeEnv.agentId}:task:${payload.taskId ?? payload.traceId}`;

    // Surface per-turn tool activity to the run-detail feed. Tool calls map to
    // the `tool_call` stream the LiveTraceFeed renders; tool results ride the
    // audit history. Assistant text is dropped here — one coalesced message is
    // emitted at run-end below.
    const result = await gatewayRun(
      target,
      {
        externalAgentId,
        prompt: wakeText,
        model: cfg.model,
        sessionKey,
        appendSystemPrompt: buildTraceSystemPrompt(ctx),
        allowedTools: TASK_TOOLS,
        disallowedTools: TASK_DENY,
        timeoutMs: TASK_TIMEOUT_MS,
        // No per-run cost cap — see sendPrompt. Bounded by the monthly budget
        // gate (at dispatch) + the wall-clock timeout.
      },
      forwardRunEvent(ctx.onEvent),
      ctx.signal,
    );

    if (!result.ok) {
      const outcome =
        result.error === "cancelled"
          ? "cancelled"
          : result.error === "timeout"
            ? "timed_out"
            : "failed";
      return {
        outcome,
        livenessState: null,
        usage: toTraceUsage(result.usage, result.costUsd),
        error: {
          code: result.error ?? "prompt_failed",
          message: result.reason ?? "codex run failed",
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
    // Continuity is the gateway's sessionKey → thread_id map. A thread clear
    // bumps resetGeneration in the sessionKey, so the gateway finds no mapping
    // and starts a brand-new codex thread on the next turn — the old
    // conversation is naturally abandoned. Nothing to wipe here.
    return { ok: true };
  },
};
