// Cross-module timing constants. Values that live in only one file should
// stay local to that file; this module is reserved for timings that are
// shared across multiple call sites.

// How long the trace-event SSE buffer waits before flushing pending events
// to `trace_events`. Trade-off between latency (lower = quicker UI updates)
// and DB write batching (higher = fewer round-trips).
export const TRACE_EVENT_FLUSH_MS = 500;

// Maximum time the gateway may take to respond to an agent chat call before
// we abandon the request. Used by both the synchronous chat route and the
// task dispatcher's per-task execution.
export const AGENT_WAIT_TIMEOUT_MS = 10 * 60_000; // 10 minutes
