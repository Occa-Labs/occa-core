// Query key factory for the tasks feature. Centralized so mutation
// hooks invalidate the same key the list query reads from — typos would
// otherwise silently break cache wiring.

export const taskKeys = {
  all: ["tasks"] as const,
  // `lists()` is the prefix; every paginated column/list query nests under
  // it, so a single `invalidateQueries({ queryKey: taskKeys.lists() })`
  // refetches the whole board (all columns + the flat list view).
  lists: () => [...taskKeys.all, "list"] as const,
  // One infinite query per board column ("todo" | "in_progress" | … |
  // "archived" | "all"). `opts` distinguishes the include-archived flat
  // list variant used by the list view.
  column: (column: string, opts: { includeArchived?: boolean } = {}) =>
    [...taskKeys.lists(), "column", column, opts] as const,
  // Per-status board totals — separate from lists so a count refresh
  // doesn't drag in card payloads.
  counts: () => [...taskKeys.all, "counts"] as const,
  detail: (id: string) => [...taskKeys.all, "detail", id] as const,
  events: (id: string) => [...taskKeys.all, "events", id] as const,
  comments: (id: string) => [...taskKeys.all, "comments", id] as const,
};
