// probeConnection: cheap liveness check that the Hermes HTTP gateway is
// reachable and the bearer token is accepted. Calls GET /v1/capabilities
// (cheaper than /v1/chat/completions, and the response gives us the
// feature flags we'd want to surface in the UI later).

import type { ProbeResult } from "@occa/runtime-core";
import type { HermesAdapterConfig } from "./types";

const PROBE_TIMEOUT_MS = 10_000;

interface CapabilitiesResponse {
  object?: string;
  platform?: string;
  model?: string;
  features?: Record<string, unknown>;
  auth?: { type?: string; required?: boolean };
}

export async function probeHermes(config: HermesAdapterConfig): Promise<ProbeResult> {
  const start = Date.now();
  const url = `${config.gatewayUrl.replace(/\/$/, "")}/v1/capabilities`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - start;

    if (res.status === 401 || res.status === 403) {
      return { ok: false, latencyMs, error: "unauthorized" };
    }
    if (!res.ok) {
      return {
        ok: false,
        latencyMs,
        error: "probe_failed",
        info: { exitCode: res.status, stderr: await safeText(res) },
      };
    }

    const body = (await res.json()) as CapabilitiesResponse;
    if (body?.object !== "hermes.api_server.capabilities") {
      return {
        ok: false,
        latencyMs,
        error: "invalid_response",
        info: { message: "unexpected capabilities payload" },
      };
    }

    return {
      ok: true,
      latencyMs,
      info: { version: body.platform ?? "hermes-agent" },
    };
  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      latencyMs,
      error: aborted ? "probe_timeout" : "unreachable",
      info: { message },
    };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
