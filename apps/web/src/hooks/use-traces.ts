"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TraceDTO, TraceEventDTO } from "@occa/shared/types";
import { ApiError, agentsApi, tracesApi } from "@/lib/api";

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

export interface UseAgentTracesResult {
  traces: TraceDTO[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
}

const PAGE_SIZE = 50;

// Head of the list polls every 5s. Older pages load on demand via loadMore.
// Refresh merges new traces from the head without dropping already-loaded older pages.
export function useAgentTraces(
  agentId: string | null,
  enabled: boolean,
): UseAgentTracesResult {
  const [traces, setTraces] = useState<TraceDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextCursorRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);

  const reload = useCallback(async () => {
    if (!agentId || !enabled) return;
    try {
      const { traces: head, nextCursor } = await agentsApi.listTraces(agentId, {
        limit: PAGE_SIZE,
      });
      setTraces((prev) => {
        if (prev.length <= PAGE_SIZE) {
          nextCursorRef.current = nextCursor;
          setHasMore(nextCursor != null);
          return head;
        }
        // Preserve already-loaded older pages. Merge head by id.
        const headIds = new Set(head.map((r) => r.id));
        const tail = prev.filter((r) => !headIds.has(r.id));
        return [...head, ...tail];
      });
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
      const { traces: page, nextCursor } = await agentsApi.listTraces(agentId, {
        limit: PAGE_SIZE,
        cursor,
      });
      setTraces((prev) => {
        const existing = new Set(prev.map((r) => r.id));
        const merged = [...prev];
        for (const r of page) if (!existing.has(r.id)) merged.push(r);
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
      setTraces([]);
      nextCursorRef.current = null;
      setHasMore(false);
      return;
    }
    setLoading(true);
    setTraces([]);
    nextCursorRef.current = null;
    setHasMore(false);
    void reload();
    const handle = setInterval(() => void reload(), 5_000);
    return () => clearInterval(handle);
  }, [agentId, enabled, reload]);

  return { traces, loading, loadingMore, hasMore, error, reload, loadMore };
}

export interface UseTraceResult {
  trace: TraceDTO | null;
  events: TraceEventDTO[];
  loading: boolean;
  error: string | null;
  cancel: () => Promise<void>;
}

// Polls trace + events. Trace status ∈ {queued, running} → 2s poll; terminal → stop.
export function useTrace(traceId: string | null): UseTraceResult {
  const [trace, setTrace] = useState<TraceDTO | null>(null);
  const [events, setEvents] = useState<TraceEventDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSeqRef = useRef(0);

  const cancel = useCallback(async () => {
    if (!traceId) return;
    try {
      const { trace } = await tracesApi.cancel(traceId);
      setTrace(trace);
    } catch (err) {
      setError(extractError(err));
    }
  }, [traceId]);

  useEffect(() => {
    if (!traceId) {
      setTrace(null);
      setEvents([]);
      lastSeqRef.current = 0;
      return;
    }
    let active = true;
    setLoading(true);

    const poll = async () => {
      try {
        const { trace } = await tracesApi.get(traceId);
        if (!active) return;
        setTrace(trace);
        const { events: newEvents, nextSeq } = await tracesApi.events(
          traceId,
          lastSeqRef.current,
        );
        if (!active) return;
        if (newEvents.length) {
          setEvents((prev) => [...prev, ...newEvents]);
          lastSeqRef.current = nextSeq;
        }
        setError(null);
      } catch (err) {
        if (active) setError(extractError(err));
      } finally {
        if (active) setLoading(false);
      }
    };

    void poll();
    const handle = setInterval(() => {
      if (trace && trace.status !== "queued" && trace.status !== "running") {
        clearInterval(handle);
        return;
      }
      void poll();
    }, 2_000);
    return () => {
      active = false;
      clearInterval(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceId]);

  return { trace, events, loading, error, cancel };
}
