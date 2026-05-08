// Per-token zod schemas for the OCCA action-block markers
// `[[OCCA:HIRE]] {...} [[/OCCA:HIRE]]` etc. Today the parser in
// task-dispatcher.ts validates these inline with ad-hoc string checks;
// centralising into zod gives uniform error reporting and a stable
// payload type per token.

import { z } from "zod";
import { LIMITS } from "../../../../lib/limits";
import { ROLE_ORDER } from "@occa/shared";

const titleField = z.string().trim().min(1).max(LIMITS.TITLE);
const descriptionField = z.string().trim().min(1).max(LIMITS.DESCRIPTION);
const acceptanceField = z
  .string()
  .trim()
  .max(LIMITS.DESCRIPTION_SHORT)
  .optional();

export const hireBlockPayload = z.object({
  targetRole: z.enum(ROLE_ORDER),
  targetName: z.string().trim().min(1).max(LIMITS.NAME),
  title: titleField,
  description: descriptionField,
  acceptanceCriteria: acceptanceField,
});

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

export const askBlockPayload = z.object({
  question: z.string().trim().min(1).max(LIMITS.DESCRIPTION),
  mentionAgentId: z.string().uuid().nullable().optional(),
});

export type HireBlockPayload = z.infer<typeof hireBlockPayload>;
export type DelegateBlockPayload = z.infer<typeof delegateBlockPayload>;
export type BlockBlockPayload = z.infer<typeof blockBlockPayload>;
export type AskBlockPayload = z.infer<typeof askBlockPayload>;

export type ActionBlockOutcome =
  | { kind: "ignored"; reason: string }
  | { kind: "approval_created" }
  | { kind: "ask_posted" }
  | { kind: "blocked"; blockerIds: string[] };
