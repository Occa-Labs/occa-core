// Query key factory for the Documents feature.

export const documentKeys = {
  all: ["documents"] as const,
  // Derived folder list for a grouping axis (date | tags).
  folders: (axis: string) => [...documentKeys.all, "folders", axis] as const,
  // One paginated page query, keyed by the active folder/search params.
  page: (params: { folderId: string; axis: string; search: string }) =>
    [...documentKeys.all, "page", params] as const,
  detail: (id: string) => [...documentKeys.all, "detail", id] as const,
};
