// Query key factory for the chat feature. Today there's only one
// implicit thread per user (the company's CEO), so no per-thread
// parameter is needed yet.

export const chatKeys = {
  all: ["chat"] as const,
  ceo: () => [...chatKeys.all, "ceo"] as const,
};
