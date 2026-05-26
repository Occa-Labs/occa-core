// Hermes-specific adapter config. Lives only in this package — must not
// leak into apps/server or apps/worker.
//
// Phase 6 pivot (2026-05-26): SSH-piped ACP transport replaced by the
// Hermes HTTP API server (`hermes gateway` with `API_SERVER_ENABLED=true`).
// OCCA now talks to a public HTTPS URL with a bearer token, same shape
// as the OpenClaw adapter. SSH-specific fields removed.

export interface HermesAdapterConfig {
  /** Public HTTPS URL of the Hermes API server, e.g. "https://hermes.occa.team". */
  gatewayUrl: string;
  /** API_SERVER_KEY bearer token configured on the VPS. */
  apiKey: string;
}

export function parseConfig(raw: Record<string, unknown>): HermesAdapterConfig | null {
  const gatewayUrl = raw.gatewayUrl;
  const apiKey = raw.apiKey;
  if (typeof gatewayUrl !== "string" || typeof apiKey !== "string") {
    return null;
  }
  return { gatewayUrl, apiKey };
}
