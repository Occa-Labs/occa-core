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
import { openclawAdapter } from "@occa/adapter-openclaw";

const registry: Record<string, AgentAdapter> = {
  openclaw: openclawAdapter,
};

export function getAdapter(type: string): AgentAdapter | null {
  return registry[type] ?? null;
}
