// Query key factory for the Documents feature.

export const documentKeys = {
  all: ["documents"] as const,
  lists: () => [...documentKeys.all, "list"] as const,
  list: (opts: { tags?: string[]; limit?: number }) =>
    [...documentKeys.lists(), opts] as const,
  detail: (id: string) => [...documentKeys.all, "detail", id] as const,
};
