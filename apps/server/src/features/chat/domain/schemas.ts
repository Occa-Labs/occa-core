// Zod schemas for the user ↔ CEO chat surface (Phase 2.5 of the
// hierarchical agent system). Routes import these and feed them to
// `.safeParse()`; services receive already-parsed values.

import { z } from "zod";
import { LIMITS } from "../../../lib/limits";

export const sendChatMessageBody = z.object({
  content: z.string().trim().min(1).max(LIMITS.DESCRIPTION),
});

export type SendChatMessageBody = z.infer<typeof sendChatMessageBody>;
