// Config shape for the codex adapter. Gateway-only (BYORT), like claude-code:
//   • `gatewayUrl` is set, so the adapter talks HTTP to a Codex Gateway
//     running on another box, with `apiKey` as the bearer.
// The model is the only other per-agent knob. Codex itself authenticates on
// the gateway box (OPENAI_API_KEY or a `codex login` ChatGPT session) — OCCA
// never holds the model credential, only the gateway bearer.

export interface CodexAdapterConfig {
  /** Model alias or id for `codex -m`. "gpt-5.5-codex" by default. */
  model: string;
  /** Remote Codex Gateway base URL. Absent surfaces as config_invalid. */
  gatewayUrl?: string;
  /** Bearer for the remote gateway. Present only with `gatewayUrl`. */
  apiKey?: string;
}

// Codex's newest frontier model (developers.openai.com/codex/models, verified
// 2026-06-27). Plain "gpt-5.5" — the "-codex" suffix lineup ended at
// gpt-5.3-codex; there is no "gpt-5.5-codex". Slugs churn ~monthly; this is the
// fallback when a config omits `model`.
const DEFAULT_MODEL = "gpt-5.5";

export function parseConfig(
  raw: Record<string, unknown>,
): CodexAdapterConfig {
  const model =
    typeof raw.model === "string" && raw.model.trim().length > 0
      ? raw.model.trim()
      : DEFAULT_MODEL;
  const gatewayUrl =
    typeof raw.gatewayUrl === "string" && raw.gatewayUrl.trim().length > 0
      ? raw.gatewayUrl.trim().replace(/\/+$/, "")
      : undefined;
  const apiKey =
    typeof raw.apiKey === "string" && raw.apiKey.length > 0
      ? raw.apiKey
      : undefined;
  return { model, gatewayUrl, apiKey };
}
