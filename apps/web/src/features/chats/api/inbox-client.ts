// Thin fetch wrappers around the Chat Inbox endpoints (Phase 1 backend).
// Lives inside the feature per CLAUDE.md's "new work in features/<name>/api/"
// rule — the shared `request` helper does auth + ApiError mapping.

import type {
  ListInboxMessagesResponse,
  ListInboxPartnersResponse,
} from "@occa/shared/types";
import { request } from "@/lib/api-client";
import { encodeParty, type InboxParty } from "../types";

export function fetchInboxPartners(
  self: InboxParty,
): Promise<ListInboxPartnersResponse> {
  const qs = new URLSearchParams({ self: encodeParty(self) });
  return request<ListInboxPartnersResponse>(
    `/api/chat/inbox/partners?${qs.toString()}`,
  );
}

export function fetchInboxMessages(args: {
  self: InboxParty;
  partner: InboxParty;
}): Promise<ListInboxMessagesResponse> {
  const qs = new URLSearchParams({
    self: encodeParty(args.self),
    partner: encodeParty(args.partner),
  });
  return request<ListInboxMessagesResponse>(
    `/api/chat/inbox/messages?${qs.toString()}`,
  );
}
