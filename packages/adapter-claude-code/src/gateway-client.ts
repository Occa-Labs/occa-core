// HTTP client for the remote Claude Gateway (BYORT mode). Mirrors the local
// `claude-cli` surface — runClaude → POST /v1/run, probeClaude → GET
// /v1/health, plus seed/deprovision — so the adapter branches on
// `config.gatewayUrl` and otherwise treats both modes identically.
//
// The gateway streams NDJSON for /v1/run: one `{t:"event"}` line per run
// event, a final `{t:"result"}` line carrying the RunClaudeResult.

import type { ClaudeStreamEvent, RunClaudeResult } from "./claude-cli";

export interface GatewayTarget {
  gatewayUrl: string;
  apiKey?: string;
}

export interface GatewayRunBody {
  externalAgentId: string;
  prompt: string;
  model: string;
  sessionKey: string;
  appendSystemPrompt?: string | null;
  allowedTools?: string[] | null;
  disallowedTools?: string[] | null;
  timeoutMs?: number;
}

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

function errorResult(error: string, reason: string): RunClaudeResult {
  return { ok: false, reply: "", sessionId: null, usage: null, costUsd: null, error, reason };
}

// GET /v1/health — confirms the gateway is reachable, the bearer is valid,
// and claude is logged in on the remote box.
export async function gatewayHealth(
  target: GatewayTarget,
): Promise<{ ok: boolean; error?: string; reason?: string }> {
  try {
    const res = await fetch(`${target.gatewayUrl}/v1/health`, {
      method: "GET",
      headers: headers(target.apiKey),
    });
    if (res.status === 401) {
      return { ok: false, error: "gateway_unauthorized", reason: "bad gateway bearer" };
    }
    if (!res.ok) {
      return { ok: false, error: "gateway_unreachable", reason: `gateway HTTP ${res.status}` };
    }
    const body = (await res.json()) as { ok?: boolean; error?: string; reason?: string };
    return body.ok
      ? { ok: true }
      : { ok: false, error: body.error ?? "gateway_unreachable", reason: body.reason };
  } catch (err) {
    return {
      ok: false,
      error: "gateway_unreachable",
      reason: err instanceof Error ? err.message : "gateway fetch failed",
    };
  }
}

// POST /v1/seed — push workspace files to the remote box.
export async function gatewaySeed(
  target: GatewayTarget,
  externalAgentId: string,
  files: Array<{ filename: string; content: string }>,
): Promise<{ ok: boolean; pushed: number; error?: string; reason?: string }> {
  try {
    const res = await fetch(`${target.gatewayUrl}/v1/seed`, {
      method: "POST",
      headers: headers(target.apiKey),
      body: JSON.stringify({ externalAgentId, files }),
    });
    if (!res.ok) {
      return { ok: false, pushed: 0, error: "seed_failed", reason: `gateway HTTP ${res.status}` };
    }
    const body = (await res.json()) as { ok?: boolean; pushed?: number };
    return { ok: body.ok === true, pushed: body.pushed ?? 0 };
  } catch (err) {
    return {
      ok: false,
      pushed: 0,
      error: "seed_failed",
      reason: err instanceof Error ? err.message : "gateway seed failed",
    };
  }
}

// POST /v1/deprovision — best-effort workspace removal on the remote box.
export async function gatewayDeprovision(
  target: GatewayTarget,
  externalAgentId: string,
): Promise<void> {
  try {
    await fetch(`${target.gatewayUrl}/v1/deprovision`, {
      method: "POST",
      headers: headers(target.apiKey),
      body: JSON.stringify({ externalAgentId }),
    });
  } catch {
    /* best-effort */
  }
}

// POST /v1/run — run one turn on the remote box, forwarding stream events and
// returning the final RunClaudeResult. Shape-identical to the local runClaude.
export async function gatewayRun(
  target: GatewayTarget,
  body: GatewayRunBody,
  onEvent?: (event: ClaudeStreamEvent) => void,
  signal?: AbortSignal,
): Promise<RunClaudeResult> {
  let res: Response;
  try {
    res = await fetch(`${target.gatewayUrl}/v1/run`, {
      method: "POST",
      headers: headers(target.apiKey),
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return errorResult("cancelled", "run aborted");
    return errorResult(
      "gateway_unreachable",
      err instanceof Error ? err.message : "gateway run fetch failed",
    );
  }

  if (res.status === 401) return errorResult("gateway_unauthorized", "bad gateway bearer");
  if (!res.ok || !res.body) {
    return errorResult("prompt_failed", `gateway HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: RunClaudeResult | null = null;

  const routeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: { t?: string; event?: ClaudeStreamEvent; result?: RunClaudeResult };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (parsed.t === "event" && parsed.event) onEvent?.(parsed.event);
    else if (parsed.t === "result" && parsed.result) result = parsed.result;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        routeLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    }
    if (buf.trim()) routeLine(buf);
  } catch (err) {
    if (signal?.aborted) return errorResult("cancelled", "run aborted");
    return errorResult(
      "gateway_unreachable",
      err instanceof Error ? err.message : "gateway stream read failed",
    );
  }

  return (
    result ?? errorResult("prompt_invalid_response", "gateway closed without a result line")
  );
}
