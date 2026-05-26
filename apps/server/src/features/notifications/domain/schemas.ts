import { z } from "zod";
import { LIMITS } from "../../../lib/limits";

export const listQuery = z.object({
  // Filter to unread only when ?unread=1
  unread: z.coerce.boolean().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIMITS.PAGINATION_MAX)
    .optional(),
});
