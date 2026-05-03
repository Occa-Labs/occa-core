import type { AgentAdapter } from "@occa/runtime-core";
import { openclawAdapter } from "@occa/adapter-openclaw";

export const adapterRegistry: Record<string, AgentAdapter> = {
  openclaw: openclawAdapter,
};

export function getAdapter(type: string): AgentAdapter | null {
  return adapterRegistry[type] ?? null;
}
