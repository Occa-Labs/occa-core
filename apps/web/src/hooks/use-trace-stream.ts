"use client";

import { useEffect, useRef, useState } from "react";
import { getStoredToken } from "@/lib/api";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002";

// Shape of events emitted by the server SSE endpoint. Mirrors
// TraceBusEvent in apps/server/src/services/trace-events-bus.ts.
export interface TraceStreamFrame {
  seq: number;
  eventType: "stream";
  stream: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface TraceLifecycleFrame {
  seq: number;
  eventType: "lifecycle";
  phase: "started" | "completed" | "failed";
  taskStatus?: string;
  error?: string;
  createdAt: string;
}

export type TraceFrame = TraceStreamFrame | TraceLifecycleFrame;

export interface UseTraceStreamResult {
  frames: TraceFrame[];
  connected: boolean;
  finished: boolean;
  error: string | null;
}

export interface UseTraceStreamOptions {
  // Called once when the trace reaches a terminal state (completed/failed).
  // Typical use: trigger a task refetch so the UI picks up the final status.
  onFinish?: (phase: "completed" | "failed") => void;
}

// Subscribes to GET /api/traces/:id/stream. Returns the growing list of frames
// seen so far plus connection state. Auto-closes when the server signals a
// terminal lifecycle event.
export function useTraceStream(
  traceId: string | null | undefined,
  opts: UseTraceStreamOptions = {},
): UseTraceStreamResult {
  const [frames, setFrames] = useState<TraceFrame[]>([]);
  const [connected, setConnected] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onFinishRef = useRef(opts.onFinish);
  onFinishRef.current = opts.onFinish;

  useEffect(() => {
    if (!traceId) {
      setFrames([]);
      setConnected(false);
      setFinished(false);
      setError(null);
      return;
    }

    const token = getStoredToken();
    if (!token) {
      setError("no_token");
      return;
    }

    const url = `${API_BASE}/api/traces/${traceId}/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    let closed = false;

    setFrames([]);
    setConnected(false);
    setFinished(false);
    setError(null);

    es.onopen = () => {
      if (!closed) setConnected(true);
    };

    es.addEventListener("stream", (e) => {
      if (closed) return;
      try {
        const frame = JSON.parse((e as MessageEvent).data) as TraceStreamFrame;
        setFrames((prev) => [...prev, frame]);
      } catch {
        /* malformed frame — ignore */
      }
    });

    es.addEventListener("lifecycle", (e) => {
      if (closed) return;
      try {
        const frame = JSON.parse(
          (e as MessageEvent).data,
        ) as TraceLifecycleFrame;
        setFrames((prev) => [...prev, frame]);
        if (frame.phase === "completed" || frame.phase === "failed") {
          setFinished(true);
          onFinishRef.current?.(frame.phase);
          // Server closes the connection shortly after; close ours too so
          // the browser doesn't auto-reconnect.
          es.close();
          closed = true;
        }
      } catch {
        /* ignore */
      }
    });

    es.addEventListener("snapshot", () => {
      // Initial trace snapshot — we don't surface it here; the React tree
      // already has the trace via the task DTO. Just ignore.
    });

    es.addEventListener("close", () => {
      es.close();
      closed = true;
      setConnected(false);
    });

    es.onerror = () => {
      if (closed) return;
      // EventSource auto-reconnects by default. If the server already closed
      // (finished === true) we don't want the reconnect; close manually.
      setConnected(false);
    };

    return () => {
      closed = true;
      es.close();
    };
  }, [traceId]);

  return { frames, connected, finished, error };
}
