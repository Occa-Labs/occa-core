"use client";

import { useQuery } from "@tanstack/react-query";
import { documentsApi } from "@/lib/api";
import type { GroupAxis } from "../types";
import { browserTimezone } from "../utils/timezone";
import { documentKeys } from "./keys";

// Derived folder list (date or tag) + total + untagged, straight from a
// server-side aggregate. No document bodies are fetched — this is what makes
// the sidebar + folder grid cheap regardless of archive size.
export function useDocumentFolders(axis: GroupAxis, enabled: boolean) {
  return useQuery({
    queryKey: documentKeys.folders(axis),
    queryFn: () => documentsApi.folders(axis, browserTimezone()),
    enabled,
    refetchOnWindowFocus: false,
  });
}
