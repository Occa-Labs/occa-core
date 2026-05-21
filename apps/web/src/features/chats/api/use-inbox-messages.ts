"use client";

// TanStack Query hook for Col 3 of the Chats window — the merged message
// stream between (viewer, partner) across every thread they share.
// Polls at the same cadence as the partners list so a fresh agent_dm
// reply lands without a manual refresh.

import { useQuery } from "@tanstack/react-query";
import type { InboxMessageDTO } from "@occa/shared/types";
import { fetchInboxMessages } from "./inbox-client";
import { encodeParty, type InboxParty } from "../types";

const POLL_INTERVAL_MS = 8_000;

export function inboxMessagesKey(self: InboxParty, partner: InboxParty) {
  return [
    "chat-inbox",
    "messages",
    encodeParty(self),
    encodeParty(partner),
  ] as const;
}

export interface UseInboxMessagesResult {
  messages: InboxMessageDTO[];
  loading: boolean;
  error: string | null;
}

export function useInboxMessages(args: {
  self: InboxParty | null;
  partner: InboxParty | null;
}): UseInboxMessagesResult {
  const enabled = args.self !== null && args.partner !== null;
  const query = useQuery({
    queryKey: enabled
      ? inboxMessagesKey(args.self!, args.partner!)
      : ["chat-inbox", "messages", "_"],
    queryFn: () =>
      fetchInboxMessages({ self: args.self!, partner: args.partner! }),
    enabled,
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: false,
    staleTime: POLL_INTERVAL_MS,
  });
  return {
    messages: query.data?.messages ?? [],
    loading: query.isPending && enabled,
    error: query.isError
      ? query.error instanceof Error
        ? query.error.message
        : "failed"
      : null,
  };
}
