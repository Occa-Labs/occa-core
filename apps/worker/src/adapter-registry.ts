import type { AgentAdapter } from "@occa/runtime-core";
import { hermesAdapter } from "@occa/adapter-hermes";
import { openclawAdapter } from "@occa/adapter-openclaw";

export const adapterRegistry: Record<string, AgentAdapter> = {
  hermes: hermesAdapter,
  openclaw: openclawAdapter,
};

export function getAdapter(type: string): AgentAdapter | null {
  return adapterRegistry[type] ?? null;
}
