import type { AgentAdapter } from "@occa/runtime-core";
import { claudeCodeAdapter } from "@occa/adapter-claude-code";
import { codexAdapter } from "@occa/adapter-codex";
import { hermesAdapter } from "@occa/adapter-hermes";
import { openclawAdapter } from "@occa/adapter-openclaw";

export const adapterRegistry: Record<string, AgentAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  hermes: hermesAdapter,
  openclaw: openclawAdapter,
};

export function getAdapter(type: string): AgentAdapter | null {
  return adapterRegistry[type] ?? null;
}
