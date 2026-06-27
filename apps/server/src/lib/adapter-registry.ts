// Adapter registry for the server.
// Mirrors the pattern used in apps/worker/src/adapter-registry.ts.
//
// To add a new adapter (e.g. claude-code):
//   1. Create the package (packages/adapter-claude-code)
//   2. Implement the AgentAdapter interface from @occa/runtime-core
//   3. Add one line here: registry["claude-code"] = claudeCodeAdapter;
//
// No other files need to change.

import type { AgentAdapter } from "@occa/runtime-core";
import { claudeCodeAdapter } from "@occa/adapter-claude-code";
import { codexAdapter } from "@occa/adapter-codex";
import { hermesAdapter } from "@occa/adapter-hermes";
import { openclawAdapter } from "@occa/adapter-openclaw";

const registry: Record<string, AgentAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  hermes: hermesAdapter,
  openclaw: openclawAdapter,
};

export function getAdapter(type: string): AgentAdapter | null {
  return registry[type] ?? null;
}

// Registered runtime types, for surfaces that need to enumerate what an
// agent can be deployed on (e.g. the CEO's PROPOSE_DEPLOYMENT catalog).
// Sourced from the live registry so it can't drift from getAdapter.
export function listAdapterTypes(): string[] {
  return Object.keys(registry);
}
