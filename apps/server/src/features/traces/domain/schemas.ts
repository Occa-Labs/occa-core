import { z } from "zod";
import { LIMITS } from "../../../lib/limits";

export const eventsQuery = z.object({
  afterSeq: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.REASON).optional(),
});

export const cancelBody = z.object({
  reason: z.string().max(LIMITS.REASON).optional(),
});
