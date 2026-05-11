// Query key factory for the Company Brain feature. Centralized so
// mutation hooks invalidate the same key the list query reads from.

export const brainKeys = {
  all: ["company-brain"] as const,
  list: () => [...brainKeys.all, "list"] as const,
};
