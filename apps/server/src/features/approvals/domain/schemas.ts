import { z } from "zod";
import { APPROVAL_DECISIONS, APPROVAL_STATUSES } from "@occa/shared/types";
import { LIMITS } from "../../../lib/limits";

export const listQuery = z.object({
  status: z.enum(APPROVAL_STATUSES).optional(),
});

const patchPayloadSchema = z.object({
  title: z.string().trim().min(1).max(LIMITS.TITLE).optional(),
  description: z.string().trim().min(1).max(LIMITS.DESCRIPTION).optional(),
  acceptanceCriteria: z
    .string()
    .trim()
    .max(LIMITS.DESCRIPTION_SHORT)
    .nullable()
    .optional(),
});

export const patchBody = z.object({
  payload: patchPayloadSchema,
});

export const decideBody = z.object({
  decision: z.enum(APPROVAL_DECISIONS),
  rejectionReason: z.string().trim().max(LIMITS.REASON).optional(),
});

// Server-stamped lifecycle keys excluded from the `originalPayload`
// snapshot so audit trail carries only what the agent requested.
export const SYSTEM_PAYLOAD_KEYS = new Set([
  "spawnedTaskId",
  "spawnedAgentId",
  "failureReason",
  "failedAt",
  "originalPayload",
  "editedByUserId",
  "editedAt",
]);
