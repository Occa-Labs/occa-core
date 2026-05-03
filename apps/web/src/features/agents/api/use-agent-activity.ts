"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityGroup } from "@occa/shared/types";
import { ApiError, agentsApi } from "@/lib/api";

function extractError(err: unknown): string {
  if (err instanceof ApiError) {
    if (
      err.body &&
      typeof err.body === "object" &&
      "error" in err.body &&
      typeof (err.body as Record<string, unknown>).error === "string"
    ) {
      return (err.body as { error: string }).error;
    }
    return `api_${err.status}`;
  }
  return err instanceof Error ? err.message : "failed";
}

export interface UseAgentActivityResult {
  groups: ActivityGroup[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
}

const PAGE_SIZE = 50;

export function useAgentActivity(
  agentId: string | null,
  enabled: boolean,
): UseAgentActivityResult {
  const [groups, setGroups] = useState<ActivityGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextCursorRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);

  const reload = useCallback(async () => {
    if (!agentId || !enabled) return;
    try {
      const { groups: head, nextCursor } = await agentsApi.activity(agentId, {
        limit: PAGE_SIZE,
      });
      setGroups(head);
      nextCursorRef.current = nextCursor;
      setHasMore(nextCursor != null);
      setError(null);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setLoading(false);
    }
  }, [agentId, enabled]);

  const loadMore = useCallback(async () => {
    if (!agentId || !enabled) return;
    if (loadingMoreRef.current) return;
    const cursor = nextCursorRef.current;
    if (!cursor) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const { groups: page, nextCursor } = await agentsApi.activity(agentId, {
        limit: PAGE_SIZE,
        cursor,
      });
      setGroups((prev) => {
        const existing = new Set(prev.map((g) => g.groupKey));
        const merged = [...prev];
        for (const g of page) if (!existing.has(g.groupKey)) merged.push(g);
        return merged;
      });
      nextCursorRef.current = nextCursor;
      setHasMore(nextCursor != null);
    } catch (err) {
      setError(extractError(err));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [agentId, enabled]);

  useEffect(() => {
    if (!agentId || !enabled) {
      setGroups([]);
      nextCursorRef.current = null;
      setHasMore(false);
      return;
    }
    setLoading(true);
    setGroups([]);
    nextCursorRef.current = null;
    setHasMore(false);
    void reload();
    const handle = setInterval(() => void reload(), 10_000);
    return () => clearInterval(handle);
  }, [agentId, enabled, reload]);

  return { groups, loading, loadingMore, hasMore, error, reload, loadMore };
}
