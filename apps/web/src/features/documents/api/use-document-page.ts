"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { documentsApi } from "@/lib/api";
import type { GroupAxis } from "../types";
import { ALL_FOLDER_ID, UNTAGGED_FOLDER_ID } from "../types";
import { browserTimezone } from "../utils/timezone";
import { documentKeys } from "./keys";

const PAGE_SIZE = 50;

interface PageParams {
  folderId: string;
  axis: GroupAxis;
  search: string;
}

/**
 * One paginated page of documents for the open folder (or the active search).
 * A non-empty search is global — it ignores the folder and queries the whole
 * archive server-side. Scroll to the bottom to pull the next 50.
 */
export function useDocumentPage(params: PageParams, enabled: boolean) {
  const search = params.search.trim();
  return useInfiniteQuery({
    queryKey: documentKeys.page({
      folderId: params.folderId,
      axis: params.axis,
      search,
    }),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      documentsApi.list({
        ...listParams(params, search),
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.length * PAGE_SIZE : undefined,
    enabled,
    refetchOnWindowFocus: false,
  });
}

function listParams(params: PageParams, search: string) {
  if (search) return { search };
  if (params.folderId === UNTAGGED_FOLDER_ID) return { untagged: true };
  if (params.folderId === ALL_FOLDER_ID) return {};
  if (params.axis === "tags") return { tags: [params.folderId] };
  return { day: params.folderId, tz: browserTimezone() };
}
