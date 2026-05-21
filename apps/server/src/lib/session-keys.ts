// Gateway session keys for agent chat threads.
//
// One gateway session per OCCA thread. Every path that wakes an agent
// inside a given thread MUST derive its session key from this helper:
//
//   • interactive user turns      — chat-handler (user_ceo)
//   • interactive agent-dm turns  — agent-dm-handler (agent_dm)
//   • background synthesis        — services/delegation/synthesis
//
// If these diverge, the gateway opens separate sessions for the same
// conversation and the agent loses context across paths — e.g. a
// synthesis report lands in the thread but the agent's interactive
// session never saw it, so the next user reply gets "I don't have that
// in context". Keep all three pointed at this single formula.
//
// Reset: the key is stable per thread id, so the gateway keeps one
// session for the life of the thread. Clearing a thread wipes that
// session explicitly via `deleteAgentSession` — see `clearThread`.

export function threadSessionKey(
  externalAgentId: string,
  threadId: string,
): string {
  return `agent:${externalAgentId}:thread:${threadId}`;
}
