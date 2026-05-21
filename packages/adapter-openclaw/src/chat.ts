// Direct communication with a provisioned OpenClaw agent via the gateway
// WebSocket. Uses the same "agent" RPC method as executeTrace.
//
// sendAgentPrompt  — low-level: caller supplies full sessionKey + message.
// chatWithAgent    — high-level: chat wrapper, builds sessionKey from conversationId.

import { v4 as uuid } from "uuid";
import { connectWithAutoPair } from "./connect-with-auto-pair";
import { OpenClawError } from "./client";
import type { DeviceIdentity } from "./keypair";

const ACCEPT_TIMEOUT_MS = 15_000;
const WAIT_TIMEOUT_MS = 120_000;

export type AgentPromptErrorCode =
  | "gateway_unreachable"
  | "gateway_handshake_timeout"
  | "device_pairing_required"
  | "gateway_unauthorized"
  | "gateway_invalid_response"
  | "prompt_failed"
  | "prompt_timed_out";

export type AgentPromptResult =
  | { ok: true; reply: string }
  | { ok: false; error: AgentPromptErrorCode; reason?: string };

// Kept for backwards compat — chat uses the same error/result shapes.
export type ChatErrorCode = AgentPromptErrorCode;
export type ChatWithAgentResult = AgentPromptResult;

// Streaming event emitted to callers of sendAgentPrompt / chatWithAgent.
// `stream` mirrors the gateway frame type: "lifecycle", "tool_call",
// "command", "assistant", "error".
export interface ChatStreamEvent {
  stream: string;
  data: Record<string, unknown>;
}

export interface SendAgentPromptInput {
  gatewayUrl: string;
  apiKey: string;
  device: DeviceIdentity;
  // Full session key — caller controls format.
  // e.g. "agent:{openclawAgentId}:chat:{convId}"
  //   or "agent:{openclawAgentId}:skill:{slugKey}"
  sessionKey: string;
  message: string;
  // Optional callback: fired for every meaningful gateway stream frame.
  onEvent?: (event: ChatStreamEvent) => void;
}

export interface ChatWithAgentInput {
  gatewayUrl: string;
  apiKey: string;
  device: DeviceIdentity;
  openclawAgentId: string;
  message: string;
  // Stable ID per conversation — session key becomes
  // "agent:{openclawAgentId}:chat:{conversationId}"
  conversationId: string;
  // Optional callback: fired for every meaningful gateway stream frame.
  onEvent?: (event: ChatStreamEvent) => void;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function normalizeStatus(v: unknown): string {
  return typeof v === "string" ? v.toLowerCase() : "";
}

function extractResultText(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const direct = asString(payload.text);
  if (direct) return direct;
  const result = asRecord(payload.result);
  if (result) {
    const t = asString(result.text) ?? asString(result.message);
    if (t) return t;
  }
  return asString(payload.message);
}

function mapGatewayError(err: unknown): AgentPromptErrorCode {
  if (err instanceof OpenClawError) {
    switch (err.code) {
      case "gateway_unreachable": return "gateway_unreachable";
      case "gateway_handshake_timeout": return "gateway_handshake_timeout";
      case "device_pairing_required": return "device_pairing_required";
      case "gateway_unauthorized": return "gateway_unauthorized";
      case "gateway_invalid_response": return "gateway_invalid_response";
    }
  }
  return "prompt_failed";
}

// Core: connect to gateway, send message under sessionKey, collect reply.
// Handles accept → agent.wait → streaming delta accumulation.
export async function sendAgentPrompt(
  input: SendAgentPromptInput,
  opts?: { handshakeTimeoutMs?: number; waitTimeoutMs?: number },
): Promise<AgentPromptResult> {
  const handshakeTimeoutMs = opts?.handshakeTimeoutMs ?? 10_000;
  const waitTimeoutMs = opts?.waitTimeoutMs ?? WAIT_TIMEOUT_MS;

  const assistantChunks: string[] = [];
  // Coalesced run-end `text` frames — atomic, splice-proof. The gateway
  // emits one per run just before `lifecycle phase=end`. The per-token
  // `delta` stream shares the WS connection and can interleave foreign
  // content under a matching runId, so the coalesced frame is preferred.
  const coalescedTexts: string[] = [];
  let lifecycleError: string | null = null;

  // The gateway WS is a firehose — frames for every concurrent run on
  // this connection arrive here. Only frames whose runId we own may
  // touch the accumulators. Seeded with idempotencyKey (the gateway may
  // echo it as runId); the accepted payload's runId is added once known.
  const idempotencyKey = uuid();
  const trackedRunIds = new Set<string>([idempotencyKey]);

  let client: Awaited<ReturnType<typeof connectWithAutoPair>>["client"] | null = null;

  try {
    const connected = await connectWithAutoPair(
      { gatewayUrl: input.gatewayUrl, apiKey: input.apiKey },
      input.device,
      {
        handshakeTimeoutMs,
        onEvent: (evt) => {
          if (evt.event !== "agent") return;
          const frame = asRecord(evt.payload);
          if (!frame) return;
          const runId = asString(frame.runId);
          if (!runId || !trackedRunIds.has(runId)) return;
          const stream = asString(frame.stream);
          const data = asRecord(frame.data) ?? {};
          if (stream === "assistant") {
            const delta = asString(data.delta);
            const text = asString(data.text);
            // `delta` = one streamed token (interleave-prone). `text` =
            // the coalesced final answer (atomic). Keep them apart so
            // the reply can prefer the coalesced frame.
            if (delta) assistantChunks.push(delta);
            else if (text) coalescedTexts.push(text);
          } else if (stream === "error") {
            lifecycleError =
              asString(data.error) ?? asString(data.message) ?? lifecycleError;
          } else if (stream === "lifecycle") {
            const phase = asString(data.phase)?.toLowerCase();
            if (phase === "error" || phase === "failed" || phase === "cancelled") {
              lifecycleError =
                asString(data.error) ?? asString(data.message) ?? lifecycleError;
            }
          }
          // Forward named streams to caller — but skip the per-token
          // `assistant` stream (one frame per token, hundreds per run).
          // The internal accumulator above already collects the full text
          // and we return the coalesced reply at the end, so consumers
          // that want the final answer don't lose anything. This keeps
          // trace_events table from ballooning (>1k rows per task on a
          // chatty agent reply).
          if (stream && stream !== "assistant" && input.onEvent) {
            input.onEvent({ stream, data });
          }
        },
      },
    );
    client = connected.client;

    const accepted = (await client.sendRpc(
      "agent",
      {
        message: input.message,
        sessionKey: input.sessionKey,
        idempotencyKey,
        timeout: waitTimeoutMs,
      },
      { timeoutMs: ACCEPT_TIMEOUT_MS },
    )) as Record<string, unknown> | null;

    let finalPayload: Record<string, unknown> | null = accepted;
    const acceptedStatus = normalizeStatus(accepted?.status);
    const runId = asString(accepted?.runId) ?? idempotencyKey;
    trackedRunIds.add(runId);

    if (acceptedStatus === "error") {
      const reason =
        asString(accepted?.error) ??
        asString(accepted?.summary) ??
        lifecycleError ??
        "gateway_agent_error";
      return { ok: false, error: "prompt_failed", reason };
    }

    if (acceptedStatus && acceptedStatus !== "ok") {
      const waitPayload = (await client.sendRpc(
        "agent.wait",
        { runId, timeoutMs: waitTimeoutMs },
        { timeoutMs: waitTimeoutMs + ACCEPT_TIMEOUT_MS },
      )) as Record<string, unknown> | null;

      finalPayload = waitPayload;
      const waitStatus = normalizeStatus(waitPayload?.status);

      if (waitStatus === "timeout") {
        return { ok: false, error: "prompt_timed_out", reason: "gateway run timed out" };
      }
      if (waitStatus && waitStatus !== "ok") {
        const reason =
          asString(waitPayload?.error) ??
          asString(waitPayload?.summary) ??
          lifecycleError ??
          `wait_status:${waitStatus || "unknown"}`;
        return { ok: false, error: "prompt_failed", reason };
      }
    }

    // Reply source priority: coalesced run-end frame (atomic) → joined
    // delta chunks (interleave-prone fallback) → accept/wait payload.
    const replyFromCoalesced =
      coalescedTexts.length > 0
        ? coalescedTexts[coalescedTexts.length - 1].trim()
        : "";
    const reply =
      replyFromCoalesced ||
      assistantChunks.join("").trim() ||
      (extractResultText(finalPayload) ?? extractResultText(accepted) ?? "");

    if (lifecycleError && !reply) {
      return { ok: false, error: "prompt_failed", reason: lifecycleError };
    }

    return { ok: true, reply };
  } catch (err) {
    return {
      ok: false,
      error: mapGatewayError(err),
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try { await client?.close(); } catch { /* ignore */ }
  }
}

// ── Fire-and-recheck API ─────────────────────────────────────────────────────
//
// fireAgentPrompt: sends the prompt and waits only for the gateway "accepted"
//   acknowledgement (fast, ~seconds). Returns the runId so the caller can poll
//   later with checkAgentRun instead of blocking the worker for minutes.
//
// checkAgentRun: connects to the gateway, calls agent.wait with a short poll
//   timeout. Returns { done: true, reply } when the run completes, or
//   { done: false } when it's still in progress.

export type FireAgentPromptResult =
  | { ok: true; runId: string }
  | { ok: false; error: AgentPromptErrorCode; reason?: string };

export interface CheckAgentRunInput {
  gatewayUrl: string;
  apiKey: string;
  device: DeviceIdentity;
  runId: string;
  // How long to wait before giving up on this poll attempt (not the total run).
  pollTimeoutMs?: number;
}

export type CheckAgentRunResult =
  | { done: true; reply: string }
  | { done: false }
  | { done: true; error: AgentPromptErrorCode; reason?: string };

export async function fireAgentPrompt(
  input: SendAgentPromptInput,
  opts?: { handshakeTimeoutMs?: number },
): Promise<FireAgentPromptResult> {
  const handshakeTimeoutMs = opts?.handshakeTimeoutMs ?? 10_000;

  let client: Awaited<ReturnType<typeof connectWithAutoPair>>["client"] | null = null;
  try {
    const connected = await connectWithAutoPair(
      { gatewayUrl: input.gatewayUrl, apiKey: input.apiKey },
      input.device,
      { handshakeTimeoutMs },
    );
    client = connected.client;

    const idempotencyKey = uuid();
    const accepted = (await client.sendRpc(
      "agent",
      {
        message: input.message,
        sessionKey: input.sessionKey,
        idempotencyKey,
        // Tell the gateway to keep the run alive for up to 30 min.
        timeout: 30 * 60_000,
      },
      { timeoutMs: ACCEPT_TIMEOUT_MS },
    )) as Record<string, unknown> | null;

    const acceptedStatus = normalizeStatus(accepted?.status);
    if (acceptedStatus === "error") {
      const reason =
        asString(accepted?.error) ??
        asString(accepted?.summary) ??
        "gateway_agent_error";
      return { ok: false, error: "prompt_failed", reason };
    }

    // If status is "ok" the run completed synchronously (rare); treat as done
    // with empty reply — caller should follow up with checkAgentRun if needed.
    const runId = asString(accepted?.runId) ?? idempotencyKey;
    return { ok: true, runId };
  } catch (err) {
    return {
      ok: false,
      error: mapGatewayError(err),
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try { await client?.close(); } catch { /* ignore */ }
  }
}

export async function checkAgentRun(
  input: CheckAgentRunInput,
): Promise<CheckAgentRunResult> {
  const pollTimeoutMs = input.pollTimeoutMs ?? 10_000;
  const assistantChunks: string[] = [];
  // Coalesced run-end `text` frames — atomic, preferred over joined
  // per-token `delta`s (which share the WS firehose and can interleave).
  const coalescedTexts: string[] = [];

  let client: Awaited<ReturnType<typeof connectWithAutoPair>>["client"] | null = null;
  try {
    const connected = await connectWithAutoPair(
      { gatewayUrl: input.gatewayUrl, apiKey: input.apiKey },
      input.device,
      {
        handshakeTimeoutMs: 10_000,
        onEvent: (evt) => {
          if (evt.event !== "agent") return;
          const frame = asRecord(evt.payload);
          if (!frame) return;
          // Drop frames from other concurrent runs on this connection.
          if (asString(frame.runId) !== input.runId) return;
          const data = asRecord(frame.data) ?? {};
          if (asString(frame.stream) === "assistant") {
            const delta = asString(data.delta);
            const text = asString(data.text);
            if (delta) assistantChunks.push(delta);
            else if (text) coalescedTexts.push(text);
          }
        },
      },
    );
    client = connected.client;

    const waitPayload = (await client.sendRpc(
      "agent.wait",
      { runId: input.runId, timeoutMs: pollTimeoutMs },
      { timeoutMs: pollTimeoutMs + 10_000 },
    )) as Record<string, unknown> | null;

    const waitStatus = normalizeStatus(waitPayload?.status);

    if (waitStatus === "timeout") {
      // Still running — caller should try again later.
      return { done: false };
    }
    if (waitStatus && waitStatus !== "ok") {
      const reason =
        asString(waitPayload?.error) ??
        asString(waitPayload?.summary) ??
        `wait_status:${waitStatus}`;
      return { done: true, error: "prompt_failed", reason };
    }

    const reply =
      (coalescedTexts.length > 0
        ? coalescedTexts[coalescedTexts.length - 1].trim()
        : "") ||
      assistantChunks.join("").trim() ||
      (extractResultText(waitPayload) ?? "");
    return { done: true, reply };
  } catch (err) {
    return {
      done: true,
      error: mapGatewayError(err),
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try { await client?.close(); } catch { /* ignore */ }
  }
}

// Chat wrapper: builds session key from conversationId.
export async function chatWithAgent(
  input: ChatWithAgentInput,
  opts?: { handshakeTimeoutMs?: number; waitTimeoutMs?: number },
): Promise<AgentPromptResult> {
  return sendAgentPrompt(
    {
      gatewayUrl: input.gatewayUrl,
      apiKey: input.apiKey,
      device: input.device,
      sessionKey: `agent:${input.openclawAgentId}:chat:${input.conversationId}`,
      message: input.message,
      onEvent: input.onEvent,
    },
    opts,
  );
}
