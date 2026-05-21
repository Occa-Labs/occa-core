// Fetches DefiLlama endpoints for the verifier. Read-only, public API,
// no key. An endpoint allowlist keeps a malformed (or adversarial)
// claims block from turning the verifier into a generic HTTP client.

import { childLogger } from "../../../../lib/logger";

const log = childLogger("services:workflows:verification:defillama");

const DEFILLAMA_BASE = "https://api.llama.fi";

// Endpoint paths must start with one of these prefixes. Extend as the
// verifier learns to check more metric families.
const ALLOWED_PREFIXES = [
  "/overview/dexs",
  "/overview/fees",
  "/overview/options",
  "/summary/dexs",
  "/summary/fees",
  "/v2/historicalChainTvl",
  "/v2/chains",
  "/tvl/",
  "/protocols",
] as const;

const REQUEST_TIMEOUT_MS = 15_000;

export function isAllowedEndpoint(endpoint: string): boolean {
  return ALLOWED_PREFIXES.some((p) => endpoint.startsWith(p));
}

// Fetches one endpoint, parsed as JSON. Caller is expected to dedupe
// repeated endpoints via `createDefillamaSource`.
async function fetchEndpoint(endpoint: string): Promise<unknown> {
  if (!isAllowedEndpoint(endpoint)) {
    throw new Error(`endpoint not in DefiLlama allowlist: "${endpoint}"`);
  }
  const url = `${DEFILLAMA_BASE}${endpoint}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`DefiLlama ${endpoint} returned HTTP ${res.status}`);
  }
  return res.json();
}

export interface DefillamaSource {
  // Resolves an endpoint to its parsed payload, fetching at most once
  // per distinct endpoint for the lifetime of this source.
  get(endpoint: string): Promise<unknown>;
}

// Per-verification-run source with request deduplication: a story that
// cites ten metrics from one endpoint triggers a single HTTP call.
export function createDefillamaSource(): DefillamaSource {
  const cache = new Map<string, Promise<unknown>>();
  return {
    get(endpoint: string): Promise<unknown> {
      const cached = cache.get(endpoint);
      if (cached) return cached;
      log.info({ endpoint }, "fetching DefiLlama endpoint");
      const pending = fetchEndpoint(endpoint);
      cache.set(endpoint, pending);
      return pending;
    },
  };
}
