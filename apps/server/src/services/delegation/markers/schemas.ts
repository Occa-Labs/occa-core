// Per-token zod schemas for the OCCA action-block markers
// `[[OCCA:DELEGATE]] {...} [[/OCCA:DELEGATE]]` etc. Today the parser in
// task-dispatcher.ts validates these inline with ad-hoc string checks;
// centralising into zod gives uniform error reporting and a stable
// payload type per token.

import { z } from "zod";
import { LIMITS } from "../../../lib/limits";

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

// REPORT marker is intentionally schema-less: its body is plain
// markdown (not JSON) so the LLM can ship long-form summaries without
// fighting JSON escape rules. The handler reads the raw text between
// the open + close tags and validates length only. See
// `./handlers.ts` handleReportBlock.

// ASK marker is intentionally absent — agents route clarification
// questions through RequestInfo (HTTP back-channel) which posts a
// comment AND pauses the task so it lands in `review`.

export type DelegateBlockPayload = z.infer<typeof delegateBlockPayload>;
export type BlockBlockPayload = z.infer<typeof blockBlockPayload>;

export type ActionBlockOutcome =
  | { kind: "ignored"; reason: string }
  // DELEGATE auto-approved: child task already created + dispatched.
  // Pre-Phase-A this was `approval_created` (inserted a pending row
  // requiring a human click). With the hierarchical algorithm now
  // enforced server-side (see `../policy.ts`), there's no reason to
  // gate CEO→subordinate handoffs on a human — the agent is the
  // authority for its own subtree.
  | { kind: "delegated"; childTaskId: string }
  | { kind: "blocked"; blockerIds: string[]; reason?: string }
  // REPORT validation passed in the handler (body + root + emitter) but
  // the actual chat-insert is deferred to the dispatcher so it can apply
  // the bypass-delegation guard with full visibility into sibling
  // outcomes (DELEGATE emitted? completed children present?). The
  // dispatcher converts this into either an inserted chat message or
  // a rejected REPORT, and emits the final audit event.
  | { kind: "report_pending"; summary: string };
