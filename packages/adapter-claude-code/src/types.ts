// Config shape for the claude-code adapter. Unlike the HTTP adapters
// (openclaw / hermes) there is no gateway URL or per-agent bearer — Claude
// Code runs as a local subprocess and auth comes from the process env
// (CLAUDE_CODE_OAUTH_TOKEN / interactive login). The only per-agent knob
// is the model; everything else is host-level.

import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeCodeAdapterConfig {
  /** Model alias or id for `claude --model`. "sonnet" by default (cheap);
   *  "opus" for heads / higher quality. */
  model: string;
}

const DEFAULT_MODEL = "sonnet";

export function parseConfig(
  raw: Record<string, unknown>,
): ClaudeCodeAdapterConfig {
  const model =
    typeof raw.model === "string" && raw.model.trim().length > 0
      ? raw.model.trim()
      : DEFAULT_MODEL;
  return { model };
}

// Per-agent workspace directory. Each deployment gets an isolated cwd so
// Claude Code's session store + seeded files don't collide. Root is
// host-level (env override, else a dir under home).
export function workspacePathFor(externalAgentId: string): string {
  const root =
    process.env.OCCA_CLAUDE_WORKSPACE_ROOT ??
    join(homedir(), ".occa-claude-agents");
  return join(root, externalAgentId);
}
