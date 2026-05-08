import { EventEmitter } from "node:events";

// Events fanned out over the bus for live SSE streaming. Mirrors the subset
// of trace_events the frontend actually renders — the DB row is source of
// truth for history; the bus is just a realtime fan-out.
export interface TraceStreamEvent {
  seq: number;
  eventType: "stream";
  stream?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: string;
}

export interface TraceLifecycleEvent {
  seq: number;
  eventType: "lifecycle";
  // `started`/`completed`/`failed` cover the trace lifecycle itself.
  // `approval_requested` fires when the dispatcher detects a DELEGATE
  // block in the agent's reply. `action_block_*` cover error paths from
  // block parsing.
  phase:
    | "started"
    | "completed"
    | "failed"
    | "approval_requested"
    | "action_block_failed"
    | "action_block_invalid_json";
  taskStatus?: string;
  error?: string;
  // Used by approval_requested + action_block_* events.
  token?: string;
  approvalId?: string;
  summary?: string;
  createdAt: string;
}

export type TraceBusEvent = TraceStreamEvent | TraceLifecycleEvent;

// One EventEmitter shared across the process. Channel names are traceIds so
// many subscribers can attach to different traces without cross-talk.
const emitter = new EventEmitter();
// Long-running task, many events — stop Node's default 10-listener warning
// from barking when a couple of SSE clients attach.
emitter.setMaxListeners(0);

function channel(traceId: string): string {
  return `trace:${traceId}`;
}

export function publishTraceEvent(traceId: string, event: TraceBusEvent): void {
  emitter.emit(channel(traceId), event);
}

export function subscribeToTrace(
  traceId: string,
  listener: (event: TraceBusEvent) => void,
): () => void {
  const ch = channel(traceId);
  emitter.on(ch, listener);
  return () => emitter.off(ch, listener);
}
