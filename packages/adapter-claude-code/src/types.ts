// Config shape for the claude-code adapter. Two modes:
//   • local (default) — Claude Code runs as a local subprocess (`claude -p`),
//     auth from the process env (CLAUDE_CODE_OAUTH_TOKEN / interactive login).
//   • remote (BYORT)  — `gatewayUrl` is set, so the adapter talks HTTP to a
//     Claude Gateway running on another box, with `apiKey` as the bearer.
// The model is the only per-agent knob in either mode.

export interface ClaudeCodeAdapterConfig {
  /** Model alias or id for `claude --model`. "sonnet" by default (cheap);
   *  "opus" for heads / higher quality. */
  model: string;
  /** Remote Claude Gateway base URL. Absent = local subprocess mode. */
  gatewayUrl?: string;
  /** Bearer for the remote gateway. Present only with `gatewayUrl`. */
  apiKey?: string;
}

const DEFAULT_MODEL = "sonnet";

export function parseConfig(
  raw: Record<string, unknown>,
): ClaudeCodeAdapterConfig {
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
