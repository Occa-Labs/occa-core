"use client";

import { useCallback } from "react";
import { agentsApi } from "@/lib/api";

export interface UseAgentSkillsResult {
  syncDesiredSkills: (agentId: string, keys: string[]) => Promise<void>;
}

export function useAgentSkills(
  onAfterSync?: () => void | Promise<void>,
): UseAgentSkillsResult {
  const syncDesiredSkills = useCallback(
    async (agentId: string, keys: string[]) => {
      await agentsApi.syncSkills(agentId, { desiredSkills: keys });
      if (onAfterSync) await onAfterSync();
    },
    [onAfterSync],
  );

  return { syncDesiredSkills };
}
