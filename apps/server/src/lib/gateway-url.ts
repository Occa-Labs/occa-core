// Gateway URL normalization helpers.
//
// The OpenClaw gateway is reached via WebSocket but the public-facing form
// (Deploy-Agent modal input, browser bookmarks, docs) typically uses `https://`.
// Internal storage on `agents.adapter_config.gatewayUrl` ends up as `wss://`
// after the adapter rewrites the scheme. That asymmetry breaks naive
// equality filters when matching "is there an agent already paired on this
// gateway?" — `https://gateway.occa.team/` vs `wss://gateway.occa.team`
// compare unequal even though they target the same host.
//
// `normalizeGatewayUrl` produces a canonical key for comparison that ignores:
//   - scheme (http / https / ws / wss)
//   - trailing slashes
//   - case differences in host
//
// Use it on both sides of any equality check. Do NOT use for the actual
// connect call — the adapter still wants the original URL.

export function normalizeGatewayUrl(url: string): string {
  return url
    .trim()
    .replace(/^(?:wss?|https?):\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}
