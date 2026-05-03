// Zod schemas for agent HTTP body / query validation.
// Pure logic — no Drizzle, no Express.

import { z } from "zod";
import {
  ADAPTER_TYPES,
  SKILL_SYNC_ACTIONS,
  type AgentChatRequest,
} from "@occa/shared/types";
import { AGENT_ROLES } from "@occa/shared/role-catalog";
import { LIMITS } from "../../../lib/limits";
import { roleSchema } from "../../../lib/role-schema";

// ── Adapter config (shared between create + patch) ───────────────────────

export const adapterConfigSchema = z.object({
  gatewayUrl: z.string().url(),
  apiKey: z.string().min(1).max(LIMITS.API_KEY),
});

// ── Mutations ────────────────────────────────────────────────────────────

// POST /api/agents — initial onboarding (CEO) or subsequent agent.
export const createAgentBody = z.object({
  name: z.string().trim().min(1).max(LIMITS.NAME),
  role: roleSchema,
  adapterType: z.enum(ADAPTER_TYPES),
  adapterConfig: adapterConfigSchema,
  // Used only on first-time onboarding (user has no company yet). Ignored
  // when the user already owns a company — agents always attach to the
  // existing one so we never end up with split companies.
  companyName: z.string().trim().min(1).max(LIMITS.NAME).optional(),
});

// PATCH /api/agents/:id
export const patchAgentBody = z.object({
  name: z.string().trim().min(1).max(LIMITS.NAME).optional(),
  role: roleSchema.optional(),
  adapterConfig: adapterConfigSchema.optional(),
  // Pass `null` to detach (becomes top-level). Server validates that the
  // candidate parent is in the same company and not a descendant.
  parentAgentId: z.string().uuid().nullable().optional(),
  // Manually re-seat the agent. Slug must match an anchor in `ALL_DESKS`
  // (shared/seating.ts). Server enforces "one agent per desk per company"
  // — concurrent re-seats race against the partial unique index.
  workstationId: z.string().min(1).max(LIMITS.LABEL).optional(),
  // 3D character pin. Format-validate against the GLB url shape; the web
  // restricts the picker to MODEL_POOL but the server stays format-only
  // so it doesn't need to import the web's pool list.
  modelOverride: z
    .string()
    .regex(/^\/models\/characters\/[a-z0-9_]+\.glb$/)
    .nullable()
    .optional(),
});

// POST /api/agents/:id/skills/sync
export const syncSkillsBody = z.object({
  desiredSkills: z
    .array(z.string().min(1).max(LIMITS.KEY))
    .max(LIMITS.DESIRED_SKILLS_MAX),
});

// POST /api/agents/:id/skills/:key/resync
export const resyncSkillBody = z.object({
  action: z.enum(SKILL_SYNC_ACTIONS).optional(),
});

// POST /api/agents/:id/tokens
export const createAgentTokenBody = z.object({
  name: z.string().trim().min(1).max(LIMITS.LABEL),
});

// POST /api/agents/:id/chat
export const agentChatBody = z.object({
  message: z.string().min(1).max(LIMITS.CHAT_MESSAGE),
  conversationId: z.string().uuid(),
}) satisfies z.ZodType<AgentChatRequest>;

// ── Queries ──────────────────────────────────────────────────────────────

export const listAgentTracesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.PAGINATION_MAX).optional(),
  cursor: z.string().datetime().optional(),
});

export const listAgentActivityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.PAGINATION_DEFAULT).optional(),
  cursor: z.string().datetime().optional(),
});

// ── Agent-driven approvals (POST /api/agents/me/approvals) ───────────────
//
// `delegate` and `hire` are spawn primitives the agent uses from its
// runtime to ask the operator for permission to continue. The agent's
// own ID + company come from the token middleware; clients never pass
// them. We snapshot the agent's most-recent running trace's taskId
// into the payload as `parentTaskId` if the agent omitted one, so the
// eventual child task is always linked into the graph.

export const delegatePayloadSchema = z.object({
  targetAgentId: z.string().uuid(),
  title: z.string().trim().min(1).max(LIMITS.TITLE),
  description: z.string().trim().min(1).max(LIMITS.DESCRIPTION),
  acceptanceCriteria: z.string().trim().max(LIMITS.DESCRIPTION_SHORT).optional(),
  parentTaskId: z.string().uuid().nullable().optional(),
});

// Hire targets a role from the catalog so workspace templates resolve.
// AGENT_ROLES is suggestion-list today (open vocabulary at the schema
// level), but for hires we constrain to the catalog so each new agent
// has role-appropriate workspace files + auto-assigned skills.
export const hirePayloadSchema = z.object({
  targetRole: z.enum(AGENT_ROLES),
  targetName: z.string().trim().min(1).max(LIMITS.NAME),
  title: z.string().trim().min(1).max(LIMITS.TITLE),
  description: z.string().trim().min(1).max(LIMITS.DESCRIPTION),
  acceptanceCriteria: z.string().trim().max(LIMITS.DESCRIPTION_SHORT).optional(),
  parentTaskId: z.string().uuid().nullable().optional(),
});

export const approvalCreateBody = z.discriminatedUnion("actionType", [
  z.object({
    actionType: z.literal("delegate"),
    payload: delegatePayloadSchema,
  }),
  z.object({
    actionType: z.literal("hire"),
    payload: hirePayloadSchema,
  }),
]);
