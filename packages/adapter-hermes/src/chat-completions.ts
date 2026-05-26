// Low-level transport: POST /v1/chat/completions with stream=true and
// SSE parsing. Used by both sendPrompt (server dispatcher) and
// executeTrace (worker dispatcher) so SSE/usage/abort handling lives in
// one place.

import type { TraceUsage } from "@occa/runtime-core";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamChatInput {
  gatewayUrl: string;
  apiKey: string;
  model?: string | null;
  messages: ChatMessage[];
  signal: AbortSignal;
  /**
   * OCCA-side session key. Sent as `X-Hermes-Session-Id` so Hermes
   * preserves conversation memory across turns under the same key.
   * When omitted, each call is a fresh stateless turn.
   */
  sessionId?: string | null;
  /**
   * Long-term memory scope (cross-session per-channel facts). Sent as
   * `X-Hermes-Session-Key`. Optional — only useful when callers want
   * per-agent persistent recall independent of conversation continuity.
   */
  sessionScope?: string | null;
  /** Fired for every assistant delta token. */
  onDelta?: (delta: string) => void;
  /** Fired once when the final `[DONE]` chunk carries usage. */
  onUsage?: (usage: TraceUsage) => void;
}

export type StreamChatErrorCode =
  | "gateway_unreachable"
  | "gateway_unauthorized"
  | "gateway_invalid_response"
  | "gateway_completion_error"
  | "gateway_completion_timeout"
  | "cancelled";

export type StreamChatResult =
  | {
      ok: true;
      reply: string;
      usage: TraceUsage | null;
    }
  | {
      ok: false;
      error: StreamChatErrorCode;
      reason: string;
      partialReply: string;
      usage: TraceUsage | null;
    };

const ACCEPT_TIMEOUT_MS = 30_000;

interface OpenAIChunkChoice {
  delta?: { content?: string | null };
  finish_reason?: string | null;
}

interface OpenAIUsageBlock {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAIChunk {
  choices?: OpenAIChunkChoice[];
  usage?: OpenAIUsageBlock | null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function mapUsage(usage: OpenAIUsageBlock | null | undefined): TraceUsage | null {
  if (!usage) return null;
  return {
    tokensIn: num(usage.prompt_tokens),
    tokensOut: num(usage.completion_tokens),
    cachedTokensIn: num(usage.prompt_tokens_details?.cached_tokens),
    // Hermes self-hosts the inference call; OCCA isn't billed at this
    // hop. Cost surfacing belongs to whatever provider sits behind the
    // configured model and is tracked elsewhere.
    costCents: 0,
  };
}

export async function streamChatCompletion(
  input: StreamChatInput,
): Promise<StreamChatResult> {
  const url = `${input.gatewayUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const body: Record<string, unknown> = {
    messages: input.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (input.model) body.model = input.model;

  // The fetch itself can hang past the worker timeout if the gateway
  // never sends headers. Layer an accept timer on top of the caller's
  // AbortSignal so a stalled connection fails cleanly.
  const acceptController = new AbortController();
  const onAbortUpstream = () => acceptController.abort();
  input.signal.addEventListener("abort", onAbortUpstream);
  const acceptTimer = setTimeout(() => acceptController.abort(), ACCEPT_TIMEOUT_MS);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.apiKey}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (input.sessionId) headers["X-Hermes-Session-Id"] = input.sessionId;
  if (input.sessionScope) headers["X-Hermes-Session-Key"] = input.sessionScope;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: acceptController.signal,
    });
  } catch (err) {
    clearTimeout(acceptTimer);
    input.signal.removeEventListener("abort", onAbortUpstream);
    if (input.signal.aborted) {
      return { ok: false, error: "cancelled", reason: "aborted", partialReply: "", usage: null };
    }
    return {
      ok: false,
      error: "gateway_unreachable",
      reason: err instanceof Error ? err.message : String(err),
      partialReply: "",
      usage: null,
    };
  }
  clearTimeout(acceptTimer);
  // Now that headers arrived, only the caller's signal can cancel.
  input.signal.removeEventListener("abort", onAbortUpstream);

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      error: "gateway_unauthorized",
      reason: await safeText(response),
      partialReply: "",
      usage: null,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: "gateway_completion_error",
      reason: `http_${response.status}: ${await safeText(response)}`,
      partialReply: "",
      usage: null,
    };
  }
  if (!response.body) {
    return {
      ok: false,
      error: "gateway_invalid_response",
      reason: "response has no body",
      partialReply: "",
      usage: null,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const chunks: string[] = [];
  let usage: TraceUsage | null = null;
  let streamError: string | null = null;

  const onAbortStream = () => {
    reader.cancel().catch(() => {
      /* swallow — already cancelled */
    });
  };
  input.signal.addEventListener("abort", onAbortStream);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; each frame is a series
      // of `field: value\n` lines. We only care about the `data:` field.
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);

        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === "[DONE]") {
            // Stream done — usage already captured in earlier chunk if
            // include_usage was honored. Some gateways send usage in
            // the final chunk just before [DONE]; either way we've
            // recorded it.
            break;
          }
          let chunk: OpenAIChunk;
          try {
            chunk = JSON.parse(payload) as OpenAIChunk;
          } catch {
            continue;
          }
          if (chunk.usage) {
            usage = mapUsage(chunk.usage);
          }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            chunks.push(delta);
            input.onDelta?.(delta);
          }
        }
      }
    }
  } catch (err) {
    if (input.signal.aborted) {
      return {
        ok: false,
        error: "cancelled",
        reason: "aborted",
        partialReply: chunks.join(""),
        usage,
      };
    }
    streamError = err instanceof Error ? err.message : String(err);
  } finally {
    input.signal.removeEventListener("abort", onAbortStream);
  }

  if (usage) input.onUsage?.(usage);

  if (streamError) {
    return {
      ok: false,
      error: "gateway_invalid_response",
      reason: streamError,
      partialReply: chunks.join(""),
      usage,
    };
  }

  return { ok: true, reply: chunks.join(""), usage };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
