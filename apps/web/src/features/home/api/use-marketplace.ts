import { useCallback, useEffect, useState } from "react";
import { marketplaceApi } from "@/lib/api";
import type { MarketplaceAgentDTO } from "@occa/shared/types";

interface MarketplaceState {
  agents: MarketplaceAgentDTO[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

// The cross-owner agent marketplace — available agents owned by other
// users that a company can (Phase 4b) invite.
export function useMarketplaceAgents(enabled = true): MarketplaceState {
  const [agents, setAgents] = useState<MarketplaceAgentDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await marketplaceApi.listAgents();
      setAgents(res.agents);
    } catch {
      setError("Failed to load the agent marketplace");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [enabled, reload]);

  return { agents, loading, error, reload };
}
