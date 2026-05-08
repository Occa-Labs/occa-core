// Query key factory for the tasks feature. Centralized so mutation
// hooks invalidate the same key the list query reads from — typos would
// otherwise silently break cache wiring.

export const taskKeys = {
  all: ["tasks"] as const,
  // `lists()` is the prefix; specific filtered lists nest under it so a
  // single `invalidateQueries({ queryKey: taskKeys.lists() })` covers
  // both active-only and include-archived caches.
  lists: () => [...taskKeys.all, "list"] as const,
  list: (opts: { includeArchived: boolean }) =>
    [...taskKeys.lists(), { includeArchived: opts.includeArchived }] as const,
  detail: (id: string) => [...taskKeys.all, "detail", id] as const,
  events: (id: string) => [...taskKeys.all, "events", id] as const,
  comments: (id: string) => [...taskKeys.all, "comments", id] as const,
};
