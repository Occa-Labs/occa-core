// Per-agent workspace directory. Each deployment gets an isolated cwd so
// codex's rollout/session store, the seeded AGENTS.md, and the gateway's
// sessionKey → thread_id map don't collide across agents. Root is host-level
// (env override, else a dir under home).

import { homedir } from "node:os";
import { join } from "node:path";

export function workspacePathFor(externalAgentId: string): string {
  const root =
    process.env.OCCA_CODEX_WORKSPACE_ROOT ??
    join(homedir(), ".occa-codex-agents");
  return join(root, externalAgentId);
}
