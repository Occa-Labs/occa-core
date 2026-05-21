"use client";

// TanStack Query hook backing Col 2 of the Chats window. Refetches on a
// short interval so the partner list reflects new agent_dm activity
// without a manual reload (live updates land as Phase 5 polish).

import { useQuery } from "@tanstack/react-query";
import type { InboxPartySummaryDTO } from "@occa/shared/types";
import { fetchInboxPartners } from "./inbox-client";
import { encodeParty, type InboxParty } from "../types";

const POLL_INTERVAL_MS = 8_000;

export function inboxPartnersKey(self: InboxParty) {
  return ["chat-inbox", "partners", encodeParty(self)] as const;
}

export interface UseInboxPartnersResult {
  partners: InboxPartySummaryDTO[];
  loading: boolean;
  error: string | null;
}

export function useInboxPartners(
  self: InboxParty | null,
): UseInboxPartnersResult {
  const query = useQuery({
    queryKey: self ? inboxPartnersKey(self) : ["chat-inbox", "partners", "_"],
    queryFn: () => fetchInboxPartners(self!),
    enabled: self !== null,
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: false,
    staleTime: POLL_INTERVAL_MS,
  });

  return {
    partners: query.data?.partners ?? [],
    loading: query.isPending && self !== null,
    error: query.isError
      ? query.error instanceof Error
        ? query.error.message
        : "failed"
      : null,
  };
}
