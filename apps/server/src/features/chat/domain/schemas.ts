// Zod schemas for the user ↔ CEO chat surface (Phase 2.5 of the
// hierarchical agent system). Routes import these and feed them to
// `.safeParse()`; services receive already-parsed values.

import { z } from "zod";
import { LIMITS } from "../../../lib/limits";

export const sendChatMessageBody = z.object({
  content: z.string().trim().min(1).max(LIMITS.DESCRIPTION),
});

export type SendChatMessageBody = z.infer<typeof sendChatMessageBody>;

// ── Chat Inbox (Chats window) ─────────────────────────────────────────
// "self" and "partner" query params encode a party as either the literal
// "user" (the auth user — only one user per company in the MVP) or
// "agent:<uuid>" (a deployment in the auth user's company).

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARTY_PATTERN = new RegExp(
  `^(user|agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`,
  "i",
);

export type InboxPartySpec =
  | { kind: "user" }
  | { kind: "deployment"; id: string };

const inboxParty = z
  .string()
  .regex(PARTY_PATTERN)
  .transform<InboxPartySpec>((s) => {
    if (s === "user") return { kind: "user" };
    const id = s.slice("agent:".length);
    if (!UUID_PATTERN.test(id)) throw new Error("invalid deployment id");
    return { kind: "deployment", id };
  });

export const listInboxPartnersQuery = z.object({
  self: inboxParty,
});
export type ListInboxPartnersQuery = z.infer<typeof listInboxPartnersQuery>;

export const listInboxMessagesQuery = z.object({
  self: inboxParty,
  partner: inboxParty,
});
export type ListInboxMessagesQuery = z.infer<typeof listInboxMessagesQuery>;
