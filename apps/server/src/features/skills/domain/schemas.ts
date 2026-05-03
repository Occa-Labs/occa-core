// Zod schemas for skill HTTP body / query validation.
// Pure logic — no Drizzle, no Express.

import { z } from "zod";
import { roleSchema } from "../../../lib/role-schema";
import { LIMITS } from "../../../lib/limits";

// Allowed-roles array can hold every role in the catalog plus a small
// buffer for future additions; cap to keep payloads sane.
const MAX_ALLOWED_ROLES = 32;

// GET /api/skills?role=<role>
export const listSkillsQuery = z.object({
  role: roleSchema.optional(),
});

// POST /api/skills/import
export const importSkillBody = z.object({
  source: z.string().min(1).max(LIMITS.API_KEY),
  allowedRoles: z.array(roleSchema).max(MAX_ALLOWED_ROLES).optional(),
});

// PATCH /api/skills/:id — admin edits allowedRoles
export const patchSkillBody = z.object({
  allowedRoles: z.array(roleSchema).max(MAX_ALLOWED_ROLES).optional(),
});
