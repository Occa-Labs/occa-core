"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  ChannelDTO,
  ChannelType,
  ChannelUpsertRequest,
} from "@occa/shared/types";
import { ApiError, agentsApi } from "@/lib/api";

export interface UseAgentChannelsResult {
  channels: ChannelDTO[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  save: (
    channelType: ChannelType,
    input: ChannelUpsertRequest,
  ) => Promise<ChannelDTO>;
  detach: (channelType: ChannelType) => Promise<void>;
  testNotify: (
    channelType: ChannelType,
  ) => Promise<{ info: Record<string, unknown> }>;
}

// Lightweight server-state hook (matches the rest of features/agents/api/
// which uses useState + useEffect rather than TanStack Query). When
// Channels graduates to a heavier surface (notifications, multi-tenant)
// migrate to TanStack Query alongside the others.
export function useAgentChannels(
  agentId: string | null,
  enabled: boolean,
): UseAgentChannelsResult {
  const [channels, setChannels] = useState<ChannelDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await agentsApi.listChannels(agentId);
      setChannels(res.channels);
    } catch (err) {
      setError(
        err instanceof ApiError ? `HTTP ${err.status}` : "Failed to load channels",
      );
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    if (!enabled || !agentId) {
      setChannels([]);
      return;
    }
    void refresh();
  }, [agentId, enabled, refresh]);

  const save = useCallback(
    async (channelType: ChannelType, input: ChannelUpsertRequest) => {
      if (!agentId) throw new Error("no agent");
      const res = await agentsApi.upsertChannel(agentId, channelType, input);
      // Refresh full list so the active set re-sorts.
      await refresh();
      return res.channel;
    },
    [agentId, refresh],
  );

  const detach = useCallback(
    async (channelType: ChannelType) => {
      if (!agentId) throw new Error("no agent");
      await agentsApi.deleteChannel(agentId, channelType);
      await refresh();
    },
    [agentId, refresh],
  );

  const testNotify = useCallback(
    async (channelType: ChannelType) => {
      if (!agentId) throw new Error("no agent");
      return agentsApi.testNotifyChannel(agentId, channelType);
    },
    [agentId],
  );

  return { channels, loading, error, refresh, save, detach, testNotify };
}
