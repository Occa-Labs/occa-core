import { z } from "zod";
import { ROLE_SLUG_MAX, ROLE_SLUG_PATTERN } from "@occa/shared/types";

// Free-form role slug: lowercase [a-z0-9_-], max 32 chars. Trim + lowercase
// at parse time so callers always get a normalized value.
export const roleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(ROLE_SLUG_MAX)
  .regex(ROLE_SLUG_PATTERN, "role must be lowercase [a-z0-9_-]");
