// Query key factory for the chat feature. The CEO surface has one implicit
// thread per company; per-agent direct chat keys by deployment id so each
// agent's thread caches independently.

export const chatKeys = {
  all: ["chat"] as const,
  ceo: () => [...chatKeys.all, "ceo"] as const,
  agent: (deploymentId: string) =>
    [...chatKeys.all, "agent", deploymentId] as const,
};
