import type {
  AdapterExecutionContext,
  AdapterTraceResult,
  LivenessState,
  TraceUsage,
} from "@occa/runtime-core";
import { buildWakeText } from "@occa/runtime-core";
import { OpenClawError } from "./client";
import { connectWithAutoPair } from "./connect-with-auto-pair";
import { deserializeKeypair, type SerializedKeypair } from "./keypair";

interface OpenclawAdapterConfig {
  gatewayUrl: string;
  apiKey: string;
  deviceKeypair: SerializedKeypair;
  // Set at provision time. Present for agents created after the 1:1 mapping
  // breaking change. When null (legacy rows before migration), executeTrace
  // falls back to the gateway's default agent.
  openclawAgentId?: string | null;
  workspacePath?: string | null;
}

// Timeouts track Paperclip's split: a short "accept" window for the ACK res
// frame, then a longer wait window if the gateway returns non-ok (queued,
// running). For short traces the gateway returns status="ok" inside the
// accept window and we never call agent.wait.
const ACCEPT_TIMEOUT_MS = 15_000;
const WAIT_TIMEOUT_MS = 180_000;

function parseConfig(raw: Record<string, unknown>): OpenclawAdapterConfig {
  const gatewayUrl = raw.gatewayUrl;
  const apiKey = raw.apiKey;
  const deviceKeypair = raw.deviceKeypair as SerializedKeypair | undefined;
  const openclawAgentId =
    typeof raw.openclawAgentId === "string" ? raw.openclawAgentId : null;
  const workspacePath =
    typeof raw.workspacePath === "string" ? raw.workspacePath : null;
  if (
    typeof gatewayUrl !== "string" ||
    typeof apiKey !== "string" ||
    !deviceKeypair
  ) {
    throw new Error("openclaw_adapter_config_invalid");
  }
  return { gatewayUrl, apiKey, deviceKeypair, openclawAgentId, workspacePath };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function normalizeStatus(v: unknown): string {
  return typeof v === "string" ? v.toLowerCase() : "";
}

// Gateway's accepted/wait payload can carry the final text in several shapes.
// Try them in Paperclip's priority order (direct text → result.text → message).
function extractResultText(
  payload: Record<string, unknown> | null,
): string | null {
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

function extractUsage(
  payload: Record<string, unknown> | null,
): TraceUsage | null {
  if (!payload) return null;
  const result = asRecord(payload.result);
  const metaCandidates = [
    asRecord(payload.meta),
    asRecord(result?.meta),
  ].filter(Boolean) as Record<string, unknown>[];
  for (const meta of metaCandidates) {
    const agentMeta = asRecord(meta.agentMeta) ?? meta;
    const usage = asRecord(agentMeta.usage) ?? asRecord(meta.usage);
    if (usage) {
      return {
        tokensIn: asNumber(
          usage.tokensIn ?? usage.inputTokens ?? usage.promptTokens,
        ),
        tokensOut: asNumber(
          usage.tokensOut ?? usage.outputTokens ?? usage.completionTokens,
        ),
        cachedTokensIn: asNumber(
          usage.cachedTokensIn ?? usage.cachedInputTokens,
        ),
        costCents: asNumber(usage.costCents),
      };
    }
  }
  return null;
}

function extractSessionId(
  payload: Record<string, unknown> | null,
): string | null {
  if (!payload) return null;
  return (
    asString(payload.sessionId) ??
    asString(asRecord(payload.result)?.sessionId) ??
    null
  );
}

// Renders the assigned-skill roster as YAML-ish preamble text. We include key +
// slug + description but not markdown body — the body lives at
// `GET {apiUrl}/api/me/agent/skills` and agents fetch it only when they decide
// a skill applies. Keeps the wake message small even for agents with many
// skills assigned.
// Decide whether a raw gateway frame is worth persisting as a run event. The
// gateway emits three kinds of spam we drop:
//   • `tick` — 2s keep-alive, no semantic payload
//   • `health` — periodic snapshot of all sessions, huge JSON
//   • `chat` — duplicate coalesced view of the assistant text stream
//   • `agent` stream=assistant — one frame per *token* (hundreds per run)
// Everything else (lifecycle phases, tool-call items, command output, errors,
// plus the synthetic `connect.ok`/`assistant.message` we emit ourselves) flows
// through untouched.
function isNoisyFrame(
  eventType: string,
  payload: Record<string, unknown> | undefined,
): boolean {
  if (eventType === "tick" || eventType === "health" || eventType === "chat") {
    return true;
  }
  if (eventType === "agent") {
    const frame = asRecord(payload);
    if (frame && asString(frame.stream) === "assistant") return true;
  }
  return false;
}

function renderSkillsBlock(skills: AdapterExecutionContext["skills"]): string {
  if (!skills || skills.length === 0) return "";
  const lines = [
    "OCCA skills assigned to you:",
    "  Fetch instructions: GET {apiUrl}/api/me/agent/skills (Bearer {apiKey})",
    "  Fetch a single file: GET {apiUrl}/api/me/agent/skills/{urlEncodedKey}/files/{path}",
    "  Use a skill when the task matches its description; ignore otherwise.",
  ];
  for (const s of skills) {
    const desc = s.description ? ` — ${s.description}` : "";
    lines.push(`  - ${s.key} (slug: ${s.slug}, name: ${s.name})${desc}`);
  }
  return lines.join("\n");
}

export async function executeTrace(
  ctx: AdapterExecutionContext,
): Promise<AdapterTraceResult> {
  const { payload, runtimeEnv, sessionParams, skills } = ctx;
  let config: OpenclawAdapterConfig;
  try {
    config = parseConfig(ctx.adapterConfig);
  } catch (err) {
    return {
      outcome: "failed",
      livenessState: null,
      usage: null,
      error: {
        code: "config_invalid",
        message: err instanceof Error ? err.message : String(err),
      },
      sessionIdAfter: null,
      resultJson: null,
    };
  }

  const device = deserializeKeypair(config.deviceKeypair);

  let client: Awaited<ReturnType<typeof connectWithAutoPair>>["client"] | null =
    null;

  const abort = new Promise<never>((_, reject) => {
    const onAbort = () => {
      ctx.signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort);
  });

  // Accumulators populated by the stream. OpenClaw gateway's "agent" RPC
  // returns an ACK payload (status=ok/accepted/...) — the actual model output
  // arrives as a series of `event.agent` frames with stream="assistant" and
  // incremental `delta`s. End-of-trace is signalled by stream="lifecycle"
  // phase="end"; errors surface as phase in {error,failed,cancelled} or as
  // stream="error" frames.
  const assistantChunks: string[] = [];
  const trackedTraceIds = new Set<string>([payload.traceId]);
  let lifecycleError: string | null = null;

  try {
    const connected = await Promise.race([
      connectWithAutoPair(
        { gatewayUrl: config.gatewayUrl, apiKey: config.apiKey },
        device,
        {
          onEvent: (evt) => {
            const framePayload = evt.payload as
              | Record<string, unknown>
              | undefined;
            if (!isNoisyFrame(evt.event, framePayload)) {
              ctx.onEvent({
                type: evt.event,
                payload: framePayload,
              });
            }
            if (evt.event !== "agent") return;
            const frame = asRecord(evt.payload);
            if (!frame) return;
            const traceId = asString(frame.runId);
            if (!traceId || !trackedTraceIds.has(traceId)) return;
            const stream = asString(frame.stream);
            const data = asRecord(frame.data) ?? {};
            if (stream === "assistant") {
              const delta = asString(data.delta);
              const text = asString(data.text);
              if (delta) assistantChunks.push(delta);
              else if (text) assistantChunks.push(text);
            } else if (stream === "error") {
              lifecycleError =
                asString(data.error) ??
                asString(data.message) ??
                lifecycleError;
            } else if (stream === "lifecycle") {
              const phase = asString(data.phase)?.toLowerCase();
              if (
                phase === "error" ||
                phase === "failed" ||
                phase === "cancelled"
              ) {
                lifecycleError =
                  asString(data.error) ??
                  asString(data.message) ??
                  lifecycleError;
              }
            }
          },
        },
      ),
      abort,
    ]);
    client = connected.client;

    ctx.onEvent({
      type: "connect.ok",
      level: "info",
      message: `Connected to gateway (protocol v${connected.hello.protocol})`,
    });

    // OpenClaw routes direct RPC traffic to a specific agent via the
    // sessionKey prefix `agent:<agentId>:<mainKey>` (per multi-agent docs).
    // We always prefix with the OCCA agent's external id so the gateway
    // selects the dedicated workspace + session store. Suffix carries the
    // task scope so concurrent tasks for the same agent stay isolated.
    const explicitSessionKey =
      sessionParams && typeof sessionParams.sessionKey === "string"
        ? (sessionParams.sessionKey as string)
        : null;
    const taskSuffix = `task:${payload.taskId ?? payload.traceId}`;
    const sessionKey = explicitSessionKey
      ? explicitSessionKey
      : config.openclawAgentId
        ? `agent:${config.openclawAgentId}:${taskSuffix}`
        : taskSuffix;

    // OpenClaw's agent RPC rejects unknown properties, so we embed the OCCA
    // callback env into the message body instead of passing it as a field.
    const skillsBlock = renderSkillsBlock(skills);
    const envPreamble = [
      "---",
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
      ...(skillsBlock ? ["", skillsBlock] : []),
      "---",
    ].join("\n");
    const wakeText = buildWakeText(payload, {
      agentName: (sessionParams?.agentName as string) ?? "agent",
      taskTitle: sessionParams?.taskTitle as string | undefined,
      taskDescription: sessionParams?.taskDescription as string | undefined,
    });

    const message = `${envPreamble}\n\n${wakeText}`;

    const agentParams = {
      message,
      sessionKey,
      idempotencyKey: payload.traceId,
      timeout: WAIT_TIMEOUT_MS,
    };

    const accepted = (await Promise.race([
      client.sendRpc("agent", agentParams, { timeoutMs: ACCEPT_TIMEOUT_MS }),
      abort,
    ])) as Record<string, unknown> | null;

    let finalPayload: Record<string, unknown> | null = accepted;
    const acceptedStatus = normalizeStatus(accepted?.status);
    const acceptedTraceId = asString(accepted?.runId) ?? payload.traceId;
    trackedTraceIds.add(acceptedTraceId);

    if (acceptedStatus === "error") {
      const message =
        asString(accepted?.error) ??
        asString(accepted?.summary) ??
        lifecycleError ??
        "gateway_agent_error";
      return {
        outcome: "failed",
        livenessState: null,
        usage: extractUsage(accepted),
        error: { code: "gateway_agent_error", message },
        sessionIdAfter: extractSessionId(accepted),
        resultJson: accepted,
      };
    }

    // Accept returned a non-terminal status — wait for completion. The
    // gateway's `agent.wait` RPC blocks until the run ends and returns the
    // final payload with `status` in {ok, error, timeout}.
    if (acceptedStatus && acceptedStatus !== "ok") {
      const waitPayload = (await Promise.race([
        client.sendRpc(
          "agent.wait",
          { runId: acceptedTraceId, timeoutMs: WAIT_TIMEOUT_MS },
          { timeoutMs: WAIT_TIMEOUT_MS + ACCEPT_TIMEOUT_MS },
        ),
        abort,
      ])) as Record<string, unknown> | null;
      finalPayload = waitPayload;
      const waitStatus = normalizeStatus(waitPayload?.status);
      if (waitStatus === "timeout") {
        return {
          outcome: "timed_out",
          livenessState: null,
          usage: extractUsage(waitPayload) ?? extractUsage(accepted),
          error: {
            code: "gateway_wait_timeout",
            message: `gateway run timed out after ${WAIT_TIMEOUT_MS}ms`,
          },
          sessionIdAfter:
            extractSessionId(waitPayload) ?? extractSessionId(accepted),
          resultJson: waitPayload ?? accepted,
        };
      }
      if (waitStatus && waitStatus !== "ok") {
        const message =
          asString(waitPayload?.error) ??
          asString(waitPayload?.summary) ??
          lifecycleError ??
          `wait_status:${waitStatus || "unknown"}`;
        return {
          outcome: "failed",
          livenessState: null,
          usage: extractUsage(waitPayload) ?? extractUsage(accepted),
          error: { code: "gateway_wait_error", message },
          sessionIdAfter:
            extractSessionId(waitPayload) ?? extractSessionId(accepted),
          resultJson: waitPayload ?? accepted,
        };
      }
    }

    // Success path. Final text prefers accumulated stream chunks; only falls
    // back to payload.text/result.text when the gateway didn't stream.
    const summaryFromChunks = assistantChunks.join("").trim();
    const summaryFromPayload =
      extractResultText(finalPayload) ?? extractResultText(accepted);
    const summary = summaryFromChunks || summaryFromPayload || "";

    // Deltas were dropped as noise; surface the coalesced assistant text as a
    // single event so the run detail view still shows what the agent said.
    if (summary) {
      ctx.onEvent({
        type: "assistant.message",
        stream: "stdout",
        message: summary,
      });
    }

    // Drive OCCA's liveness purely off whether the agent produced real output.
    // "working" or other gateway-side hints aren't part of OCCA's LivenessState
    // enum; task-sync only advances the kanban card on "normal".
    const liveness: LivenessState = summary ? "normal" : "empty_response";
    ctx.onLivenessHint(liveness);

    const usage = extractUsage(finalPayload) ?? extractUsage(accepted);
    const sessionIdAfter =
      extractSessionId(finalPayload) ?? extractSessionId(accepted);

    return {
      outcome: "succeeded",
      livenessState: liveness,
      usage,
      error: null,
      sessionIdAfter,
      // Surface the extracted text at the top level so task-sync's REVIEW
      // marker check and the UI can read it without digging into result.meta.
      resultJson: {
        ...(finalPayload ?? accepted ?? {}),
        text: summary,
      },
    };
  } catch (err) {
    const code = err instanceof OpenClawError ? err.code : "adapter_error";
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.message === "aborted") {
      return {
        outcome: "cancelled",
        livenessState: null,
        usage: null,
        error: { code: "cancelled", message: "run aborted" },
        sessionIdAfter: null,
        resultJson: null,
      };
    }
    return {
      outcome: "failed",
      livenessState: null,
      usage: null,
      error: { code, message },
      sessionIdAfter: null,
      resultJson: null,
    };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore close errors
      }
    }
  }
}
