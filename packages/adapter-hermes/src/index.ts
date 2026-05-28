// @occa/adapter-hermes — Hermes Agent runtime adapter
//
// Phase 6 (2026-05-26): SSH-piped ACP transport replaced by Hermes' own
// OpenAI-compatible HTTP gateway (`hermes gateway` + API_SERVER_ENABLED).
// OCCA holds a public HTTPS URL + bearer token; runtime calls are pure
// HTTP. Hermes/Nous Portal-specific terms stay confined to this package.

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
  streamChatCompletion,
  type ChatMessage,
  type StreamChatResult,
} from "./chat-completions";
import { probeHermes } from "./probe";
import { parseConfig } from "./types";

export type { HermesAdapterConfig } from "./types";
export { probeHermes } from "./probe";

interface HermesRuntimeConfig {
  gatewayUrl: string;
  apiKey: string;
  /** Optional override; falls back to Hermes' configured default model. */
  model: string | null;
}

function readRuntimeConfig(raw: Record<string, unknown>): HermesRuntimeConfig | null {
  const base = parseConfig(raw);
  if (!base) return null;
  const model = typeof raw.model === "string" && raw.model.length > 0 ? raw.model : null;
  return { gatewayUrl: base.gatewayUrl, apiKey: base.apiKey, model };
}

function renderSkillsBlock(skills: AssignedSkill[]): string {
  if (!skills || skills.length === 0) return "";
  const lines = [
    "OCCA skills assigned to you (full content below — read before acting):",
    "",
    "Auxiliary lookups (only if you need extra files for a multi-file skill):",
    "  GET {apiUrl}/api/me/agent/skills/{urlEncodedKey}/files/{path}",
  ];
  for (const s of skills) {
    const desc = s.description ? ` — ${s.description}` : "";
    lines.push("");
    lines.push(`=== SKILL: ${s.key} (slug: ${s.slug}, name: ${s.name})${desc} ===`);
    lines.push("");
    lines.push(s.markdown.trim());
    lines.push("");
    lines.push(`=== END SKILL: ${s.key} ===`);
  }
  return lines.join("\n");
}

// Render persona / workspace markdown inline so the agent has its
// identity context without needing a read_file tool — Hermes' gateway
// doesn't host a per-agent filesystem, so file-read tool calls would
// otherwise fail with "File not found". OCCA is the authoritative
// source for file content; this block is the only canonical copy the
// agent sees.
function renderWorkspaceFilesBlock(files: WorkspaceFile[]): string {
  if (!files || files.length === 0) return "";
  const lines = [
    "Your workspace files (full content below — these are your identity,",
    "team awareness, and operating notes; treat them as authoritative):",
  ];
  for (const f of files) {
    lines.push("");
    lines.push(`=== FILE: ${f.filename} ===`);
    lines.push("");
    lines.push(f.content.trim());
    lines.push("");
    lines.push(`=== END FILE: ${f.filename} ===`);
  }
  return lines.join("\n");
}

// Hermes' built-in MemoryStore (memory_enabled / user_profile_enabled
// flags in config.yaml) injects `~/.hermes/memories/MEMORY.md` +
// `USER.md` into the runtime-side system prompt BEFORE OCCA's messages
// arrive. That content is runtime-home-wide — shared across every OCCA
// agent talking to the same Hermes box — and OCCA has no API to scope
// or wipe it. We can't stop the injection without the operator
// disabling those flags server-side, so the only thing we can do from
// here is tell the agent, in our own system message, to treat anything
// the runtime injected as stale and authoritative. The OCCA workspace
// files block below this is the agent's real identity.
const RUNTIME_MEMORY_OVERRIDE = [
  "PRIORITY — IGNORE PRIOR RUNTIME MEMORY BLOCKS:",
  "If any `Memory`, `User profile`, `Things to remember`, or similar",
  "pre-existing block was injected above this instruction by the agent",
  "runtime itself, treat it as STALE DATA from unrelated conversations.",
  "Do not act on it, do not reference it, do not 'recall' facts from it.",
  "Your authoritative identity, persona, and operating context comes",
  "EXCLUSIVELY from the OCCA workspace files and skills below + the",
  "current user message in this thread.",
].join("\n");

function buildSystemPrompt(ctx: AdapterExecutionContext): string {
  const { runtimeEnv, skills, workspaceFiles } = ctx;
  const filesBlock = renderWorkspaceFilesBlock(workspaceFiles);
  const skillsBlock = renderSkillsBlock(skills);
  const lines = [
    RUNTIME_MEMORY_OVERRIDE,
    "",
    "OCCA runtime:",
    `  apiUrl: ${runtimeEnv.apiUrl}`,
    `  apiKey: ${runtimeEnv.apiKey}`,
    `  agentId: ${runtimeEnv.agentId}`,
    `  traceId: ${runtimeEnv.traceId}`,
    "",
    "Task status (kanban):",
    "  - default: task auto-moves to `done` when you finish this run",
    "  - if you need a human to review/approve your work before closing,",
    "    include the literal marker `[[OCCA:REVIEW]]` anywhere in your",
    "    reply and the task will land in the `review` column instead.",
  ];
  if (filesBlock) {
    lines.push("");
    lines.push(filesBlock);
  }
  if (skillsBlock) {
    lines.push("");
    lines.push(skillsBlock);
  }
  return lines.join("\n");
}

export const hermesAdapter: AgentAdapter = {
  type: "hermes",
  // Hermes /v1/chat/completions is stateless by default, BUT supports
  // turn-to-turn continuity via `X-Hermes-Session-Id`. The adapter sets
  // that header from OCCA's sessionKey on every call, so callers can
  // rely on per-sessionKey memory the same way they do with OpenClaw.
  sessionMemory: "preserved",

  async probeConnection(config): Promise<ProbeResult> {
    const c = config as Record<string, unknown>;
    if (typeof c.gatewayUrl !== "string" || typeof c.apiKey !== "string") {
      return { ok: false, latencyMs: 0, error: "config_invalid" };
    }
    return probeHermes({ gatewayUrl: c.gatewayUrl, apiKey: c.apiKey });
  },

  async prepareCredentials(baseConfig): Promise<PrepareCredentialsResult> {
    // Hermes has no adapter-internal credentials to mint, but the
    // contract still asks us to "validate base creds" — so probe the
    // gateway with the supplied bearer here. That gives unified callers
    // a single fail-fast point (matches OpenClaw, whose
    // prepareCredentials already probes via validateDeviceKeypair).
    const c = baseConfig as Record<string, unknown>;
    if (typeof c.gatewayUrl !== "string" || typeof c.apiKey !== "string") {
      return {
        ok: false,
        error: "config_invalid",
        reason: "gatewayUrl and apiKey are required",
      };
    }
    const probe = await probeHermes({
      gatewayUrl: c.gatewayUrl,
      apiKey: c.apiKey,
    });
    if (!probe.ok) {
      return {
        ok: false,
        error: probe.error ?? "probe_failed",
        reason:
          (probe.info as { message?: string } | undefined)?.message ?? undefined,
      };
    }
    return { ok: true, configPatch: {} };
  },

  async provision(input: AdapterProvisionInput): Promise<AdapterProvisionResult> {
    // HTTP gateway has no per-agent provisioning step — the API server
    // is already running on the VPS. Echo the desired id back so the
    // dispatcher has a stable handle.
    return {
      ok: true,
      externalAgentId: input.desiredExternalId,
      workspacePath: input.workspacePath,
      configPatch: {},
    };
  },

  async deprovision(_input: AdapterDeprovisionInput): Promise<void> {
    /* no-op on HTTP gateway */
  },

  async seedWorkspace(_input: AdapterSeedInput): Promise<AdapterSeedResult> {
    // OCCA renders the full system prompt + relevant history on every
    // request to /v1/chat/completions, so workspace files live in OCCA's
    // DB (for audit + UI surfacing) and are never pushed to the Hermes
    // VPS filesystem. Caller still persists the rendered files server-side.
    return { ok: true, pushed: 0 };
  },

  async sendPrompt(
    input: AdapterSendPromptInput,
  ): Promise<AdapterSendPromptResult> {
    const config = readRuntimeConfig(input.adapterConfig);
    if (!config) {
      return {
        ok: false,
        error: "config_invalid",
        reason: "missing gatewayUrl or apiKey",
      };
    }

    // sessionKey gets forwarded as `X-Hermes-Session-Id` so Hermes
    // preserves per-thread conversation memory across calls — matches
    // OpenClaw's per-sessionKey memory model. Caller only needs to send
    // the current user message; prior turns ride on Hermes-side state.
    const messages: ChatMessage[] = [{ role: "user", content: input.message }];

    // Forward streaming deltas as `assistant` frames so consumers built
    // for OpenClaw's stream shape keep working without branching.
    const onDelta = input.onEvent
      ? (delta: string) => input.onEvent?.("assistant", { delta })
      : undefined;

    const controller = new AbortController();
    const timer = input.waitTimeoutMs
      ? setTimeout(() => controller.abort(), input.waitTimeoutMs)
      : null;

    let result: StreamChatResult;
    try {
      result = await streamChatCompletion({
        gatewayUrl: config.gatewayUrl,
        apiKey: config.apiKey,
        model: config.model,
        messages,
        sessionId: input.sessionKey,
        // Hermes' memory plugin (honcho) scopes long-term recall to
        // Session-Key. Without it, recall defaults to a broader scope
        // and the agent remembers facts across what should be fresh
        // conversations. Mirror sessionId here so a `clearThread`
        // resetGeneration bump rotates BOTH the conversation history
        // and the memory bucket together.
        sessionScope: input.sessionKey,
        signal: controller.signal,
        onDelta,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!result.ok) {
      input.onEvent?.("error", { error: result.error, reason: result.reason });
      return { ok: false, error: result.error, reason: result.reason };
    }

    return { ok: true, reply: result.reply };
  },

  async executeTrace(ctx: AdapterExecutionContext): Promise<AdapterTraceResult> {
    const config = readRuntimeConfig(ctx.adapterConfig);
    if (!config) {
      return {
        outcome: "failed",
        livenessState: null,
        usage: null,
        error: { code: "config_invalid", message: "missing gatewayUrl or apiKey" },
        sessionIdAfter: null,
        resultJson: null,
      };
    }

    const { payload, sessionParams } = ctx;
    const systemPrompt = buildSystemPrompt(ctx);
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

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: wakeText },
    ];

    // Pin this trace to a Hermes session id so continuations of the
    // same task ride on the same conversation memory. Mirror OpenClaw's
    // session-key shape: explicit one from sessionParams wins, otherwise
    // derive from agentId + task scope.
    const explicitSessionKey =
      sessionParams && typeof sessionParams.sessionKey === "string"
        ? (sessionParams.sessionKey as string)
        : null;
    const taskSuffix = `task:${payload.taskId ?? payload.traceId}`;
    const sessionId =
      explicitSessionKey ??
      `agent:${ctx.runtimeEnv.agentId}:${taskSuffix}`;

    const result = await streamChatCompletion({
      gatewayUrl: config.gatewayUrl,
      apiKey: config.apiKey,
      model: config.model,
      messages,
      sessionId,
      // Memory scope tracks the task session so cross-task recall on
      // the Hermes side stays bounded. See sendPrompt note above.
      sessionScope: sessionId,
      signal: ctx.signal,
      onDelta: (delta) => {
        // Per-token frames are kept out of the run event log on purpose
        // — they fire hundreds of times per run and would balloon
        // trace_events. The coalesced assistant message is emitted once
        // below, mirroring the openclaw adapter.
        void delta;
      },
    });

    if (!result.ok) {
      if (result.error === "cancelled") {
        return {
          outcome: "cancelled",
          livenessState: null,
          usage: result.usage,
          error: { code: "cancelled", message: "run aborted" },
          sessionIdAfter: null,
          resultJson: null,
        };
      }
      return {
        outcome: "failed",
        livenessState: null,
        usage: result.usage,
        error: { code: result.error, message: result.reason },
        sessionIdAfter: null,
        resultJson: result.partialReply ? { text: result.partialReply } : null,
      };
    }

    const summary = result.reply.trim();
    if (summary) {
      ctx.onEvent({
        type: "assistant.message",
        stream: "stdout",
        message: summary,
      });
    }

    const liveness: LivenessState = summary ? "normal" : "empty_response";
    ctx.onLivenessHint(liveness);

    return {
      outcome: "succeeded",
      livenessState: liveness,
      usage: result.usage,
      error: null,
      // Hermes is stateless — no gateway-side session to surface. Chat
      // continuity, when it lands, will be driven by OCCA-side message
      // history, not a server-issued session id.
      sessionIdAfter: null,
      resultJson: { text: summary },
    };
  },

  async resetSession(
    _input: AdapterResetSessionInput,
  ): Promise<AdapterResetSessionResult> {
    // Hermes is stateless: each request renders full context, so
    // there's no per-session memory to wipe. Caller already cleared
    // OCCA-side messages by the time this runs.
    return { ok: true };
  },
};
