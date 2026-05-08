// Per-token zod schemas for the OCCA action-block markers
// `[[OCCA:DELEGATE]] {...} [[/OCCA:DELEGATE]]` etc. Today the parser in
// task-dispatcher.ts validates these inline with ad-hoc string checks;
// centralising into zod gives uniform error reporting and a stable
// payload type per token.

import { z } from "zod";
import { LIMITS } from "../../../../lib/limits";

const titleField = z.string().trim().min(1).max(LIMITS.TITLE);
const descriptionField = z.string().trim().min(1).max(LIMITS.DESCRIPTION);
const acceptanceField = z
  .string()
  .trim()
  .max(LIMITS.DESCRIPTION_SHORT)
  .optional();

export const delegateBlockPayload = z.object({
  targetAgentId: z.string().uuid(),
  title: titleField,
  description: descriptionField,
  acceptanceCriteria: acceptanceField,
});

export const blockBlockPayload = z.object({
  blockedByTaskIds: z.array(z.string().uuid()).min(1),
  reason: z.string().trim().max(LIMITS.REASON).optional(),
});

// ASK marker removed per task-system-design.md Action catalog — agents
// route clarification questions through RequestInfo (HTTP back-channel)
// which posts a comment AND pauses the task so it lands in `review`.

export type DelegateBlockPayload = z.infer<typeof delegateBlockPayload>;
export type BlockBlockPayload = z.infer<typeof blockBlockPayload>;

export type ActionBlockOutcome =
  | { kind: "ignored"; reason: string }
  | { kind: "approval_created" }
  | { kind: "blocked"; blockerIds: string[]; reason?: string };
