import { useCallback, useEffect, useRef, useState } from "react";
import { agentsApi } from "@/lib/api";
import type { AgentSkillSyncDTO, AgentSkillSyncAction } from "@occa/shared/types";

const POLL_INTERVAL_MS = 5_000;

function hasActiveSync(syncs: AgentSkillSyncDTO[]): boolean {
  return syncs.some((s) => s.status === "pending" || s.status === "installing");
}

interface AgentSkillSyncsState {
  syncs: AgentSkillSyncDTO[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  resync: (skillKey: string, action?: AgentSkillSyncAction) => Promise<void>;
}

export function useAgentSkillSyncs(
  agentId: string,
  enabled = true,
): AgentSkillSyncsState {
  const [syncs, setSyncs] = useState<AgentSkillSyncDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const scheduleNext = useCallback(
    (currentSyncs: AgentSkillSyncDTO[]) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (!hasActiveSync(currentSyncs)) return;
      timerRef.current = setTimeout(() => void silentReload(), POLL_INTERVAL_MS);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const silentReload = useCallback(async () => {
    if (!mountedRef.current) return;
    try {
      const res = await agentsApi.listSkillSyncs(agentId);
      if (!mountedRef.current) return;
      setSyncs(res.syncs);
      scheduleNext(res.syncs);
    } catch {
      // silently ignore poll errors
    }
  }, [agentId, scheduleNext]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await agentsApi.listSkillSyncs(agentId);
      if (!mountedRef.current) return;
      setSyncs(res.syncs);
      scheduleNext(res.syncs);
    } catch {
      setError("Failed to load skill syncs");
    } finally {
      setLoading(false);
    }
  }, [agentId, scheduleNext]);

  const resync = useCallback(
    async (skillKey: string, action?: AgentSkillSyncAction) => {
      const res = await agentsApi.resyncSkill(agentId, skillKey, action);
      setSyncs((prev) => {
        const idx = prev.findIndex((s) => s.skillKey === skillKey);
        const next = idx === -1 ? [...prev, res.sync] : prev.map((s, i) => i === idx ? res.sync : s);
        scheduleNext(next);
        return next;
      });
    },
    [agentId, scheduleNext],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) return;
    void reload();
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [agentId, enabled, reload]);

  return { syncs, loading, error, reload, resync };
}
