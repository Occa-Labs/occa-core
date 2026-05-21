// Zod schemas for tool HTTP body validation.
// Pure logic. No Drizzle, no Express. Handler-specific credential and
// input shapes live in the handler files themselves; these schemas
// validate the generic envelope around them.

import { z } from "zod";
import { roleSchema } from "../../../lib/role-schema";
import { LIMITS } from "../../../lib/limits";

// Cap mirrors features/skills/domain/schemas.ts so import payloads stay
// bounded regardless of which gate the operator is touching.
const MAX_ALLOWED_ROLES = 32;

// POST /api/companies/:id/tools
export const installToolBody = z.object({
  type: z.string().min(1).max(LIMITS.TOOL_TYPE),
  label: z.string().trim().min(1).max(LIMITS.TOOL_LABEL),
  // Credentials are validated per-handler via the handler's
  // credentialsSchema. The route layer parses the outer envelope here
  // and then defers field validation to the handler.
  credentials: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()).optional(),
  allowedRoles: z.array(roleSchema).max(MAX_ALLOWED_ROLES).optional(),
  testAfterInstall: z.boolean().optional(),
});

// PATCH /api/companies/:id/tools/:toolId
export const updateToolBody = z.object({
  label: z.string().trim().min(1).max(LIMITS.TOOL_LABEL).optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["active", "paused"]).optional(),
  allowedRoles: z.array(roleSchema).max(MAX_ALLOWED_ROLES).optional(),
});

// POST /api/tools/:toolInstanceId/actions/:actionName
// Body shape is intentionally loose — the per-action inputSchema in the
// handler does the strong validation. We only ensure we got a JSON object.
export const invokeToolBody = z.object({
  input: z.record(z.string(), z.unknown()),
});

// Query for GET /api/companies/:id/tools/:toolId/logs
export const listToolLogsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.PAGINATION_MAX).optional(),
  before: z.string().datetime().optional(),
});
