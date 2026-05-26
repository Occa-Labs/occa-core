// Adapter session keys for agent chat threads.
//
// One adapter-side session per OCCA thread. Every path that wakes an
// agent inside a given thread MUST derive its session key from this
// helper:
//
//   • interactive user turns      — chat-handler (user_ceo)
//   • interactive agent-dm turns  — agent-dm-handler (agent_dm)
//   • background synthesis        — services/delegation/synthesis
//
// If these diverge, the adapter opens separate sessions for the same
// conversation and the agent loses context across paths — e.g. a
// synthesis report lands in the thread but the agent's interactive
// session never saw it, so the next user reply gets "I don't have that
// in context". Keep all three pointed at this single formula.
//
// Reset: the key is stable per (threadId, resetGeneration). `clearThread`
// increments `chat_threads.reset_generation`, which appends a `:gen-N`
// suffix and forces every adapter onto a fresh per-session bucket on
// the next turn. For OpenClaw the explicit `sessions.delete` RPC is
// fired alongside as best-effort cleanup; for adapters without an HTTP
// session-delete (Hermes), the generation bump is the only mechanism
// that breaks continuity with the prior conversation.

export function threadSessionKey(
  externalAgentId: string,
  threadId: string,
  resetGeneration = 0,
): string {
  const base = `agent:${externalAgentId}:thread:${threadId}`;
  return resetGeneration > 0 ? `${base}:gen-${resetGeneration}` : base;
}
