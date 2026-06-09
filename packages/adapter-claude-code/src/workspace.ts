// Per-agent workspace directory. Each deployment gets an isolated cwd so
// Claude Code's session store + seeded files don't collide. Root is
// host-level (env override, else a dir under home). Shared by the adapter
// (local mode) and the gateway so both resolve the same path for an agent.

import { homedir } from "node:os";
import { join } from "node:path";

export function workspacePathFor(externalAgentId: string): string {
  const root =
    process.env.OCCA_CLAUDE_WORKSPACE_ROOT ??
    join(homedir(), ".occa-claude-agents");
  return join(root, externalAgentId);
}
