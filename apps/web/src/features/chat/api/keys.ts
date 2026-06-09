// Query key factory for the chat feature. The CEO surface has one implicit
// thread per company; per-agent direct chat keys by deployment id so each
// agent's thread caches independently.

export const chatKeys = {
  all: ["chat"] as const,
  ceo: () => [...chatKeys.all, "ceo"] as const,
  agent: (deploymentId: string) =>
    [...chatKeys.all, "agent", deploymentId] as const,
  // Base key for one chat target (CEO when deploymentId omitted).
  target: (deploymentId?: string) =>
    deploymentId ? chatKeys.agent(deploymentId) : chatKeys.ceo(),
  // History session list for a target.
  sessions: (deploymentId?: string) =>
    [...chatKeys.target(deploymentId), "sessions"] as const,
  // Messages of one past session (reset_generation) for a target.
  session: (deploymentId: string | undefined, generation: number) =>
    [...chatKeys.target(deploymentId), "session", generation] as const,
};
