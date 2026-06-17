// Cross-module timing constants. Values that live in only one file should
// stay local to that file; this module is reserved for timings that are
// shared across multiple call sites.

// How long the trace-event SSE buffer waits before flushing pending events
// to `trace_events`. Trade-off between latency (lower = quicker UI updates)
// and DB write batching (higher = fewer round-trips).
export const TRACE_EVENT_FLUSH_MS = 500;

// Maximum time the gateway may take to respond to an interactive agent call
// (chat / DM) before we abandon the request. Short on purpose — a human is
// waiting on the other end.
export const AGENT_WAIT_TIMEOUT_MS = 10 * 60_000; // 10 minutes

// Maximum time a background agent work-run may take before we abandon the
// wait. Used by the task dispatcher, head review, and delegation synthesis —
// real deliverables (research + verification + long writing) routinely run
// past the interactive 10-minute window. Must stay <= the adapter's own
// wall-clock TASK_TIMEOUT_MS so the gateway run isn't cut first.
export const TASK_DISPATCH_TIMEOUT_MS = 20 * 60_000; // 20 minutes

// Lifetime of a per-trace agent API key. The dispatcher mints a fresh
// key on every wake, embeds it in the OCCA-runtime preamble, and revokes
// it in the trace finally block. Expiry is belt-and-suspenders for the
// case where the dispatcher crashes before revoke runs: an attacker who
// scrapes the key from gateway conversation history past this window
// can no longer replay it.
export const AGENT_KEY_TRACE_TTL_MS = 30 * 60_000; // 30 minutes
