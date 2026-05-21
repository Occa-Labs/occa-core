"use client";

import { useCallback } from "react";
import { agentsApi } from "@/lib/api";

export interface UseAgentToolsResult {
  syncEnabledTools: (agentId: string, toolIds: string[]) => Promise<void>;
}

export function useAgentTools(
  onAfterSync?: () => void | Promise<void>,
): UseAgentToolsResult {
  const syncEnabledTools = useCallback(
    async (agentId: string, toolIds: string[]) => {
      await agentsApi.syncTools(agentId, { enabledTools: toolIds });
      if (onAfterSync) await onAfterSync();
    },
    [onAfterSync],
  );

  return { syncEnabledTools };
}
