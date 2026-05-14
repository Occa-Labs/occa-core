// Zod schemas for agent HTTP body / query validation.
// Pure logic — no Drizzle, no Express.

import { z } from "zod";
import {
  ADAPTER_TYPES,
  SKILL_SYNC_ACTIONS,
  type AgentChatRequest,
} from "@occa/shared/types";
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
  // Optional explicit parent. When omitted / null the server falls back
  // to catalog-driven auto-resolve. Validated against the requester's
  // company in the route handler before insert.
  parentAgentId: z.string().uuid().nullable().optional(),
});

// POST /api/agents/:id/reprovision
//
// Body is optional. When `adapterConfig` is supplied, the route writes
// it onto the runtime profile and mints a fresh device keypair before
// running provision — used for chain-recovery re-pair, where the row
// exists from chain rebuild but Tier 3 (creds + keypair) was wiped.
// When omitted, reprovision uses the stored config (the "retry partial
// provision" path).
export const reprovisionAgentBody = z.object({
  adapterConfig: adapterConfigSchema.optional(),
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
// `delegate` is the only spawn primitive — agents may assign work to
// other existing agents in their subtree, subject to user approval.
// (Hire was removed: bringing brand-new agents onto the team needs a
// proper context-handoff design before re-enabling.) The agent's own
// ID + company come from the token middleware; clients never pass
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

export const approvalCreateBody = z.discriminatedUnion("actionType", [
  z.object({
    actionType: z.literal("delegate"),
    payload: delegatePayloadSchema,
  }),
]);
