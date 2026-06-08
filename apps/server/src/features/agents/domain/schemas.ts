// Zod schemas for agent HTTP body / query validation.
// Pure logic — no Drizzle, no Express.

import { z } from "zod";
import { SKILL_SYNC_ACTIONS } from "@occa/shared/types";
import { LIMITS } from "../../../lib/limits";
import { roleSchema } from "../../../lib/role-schema";

// ── Adapter config (per-adapter shapes) ──────────────────────────────────
//
// Two adapters today: openclaw (WS gateway + bearer) and hermes (HTTP
// gateway + bearer). `createAgentBody` discriminates on `adapterType` so
// each new agent has the correct config shape for its runtime.
// `patchAgentBody` and `reprovisionAgentBody` accept either shape via a
// plain union — the route handler knows the agent's adapterType from the
// DB record and is expected to revalidate before persisting.

export const openclawAdapterConfigSchema = z.object({
  gatewayUrl: z.string().url(),
  apiKey: z.string().min(1).max(LIMITS.API_KEY),
});

export const hermesAdapterConfigSchema = z.object({
  gatewayUrl: z.string().url(),
  apiKey: z.string().min(1).max(LIMITS.API_KEY),
});

// claude-code runs as a local subprocess (`claude -p`) authed from the
// host env (CLAUDE_CODE_OAUTH_TOKEN / interactive login). No gateway or
// per-agent bearer — the only per-agent knob is the model.
export const claudeCodeAdapterConfigSchema = z.object({
  model: z.string().trim().min(1).max(LIMITS.LABEL).optional(),
});

export const adapterConfigSchema = z.union([
  openclawAdapterConfigSchema,
  hermesAdapterConfigSchema,
  claudeCodeAdapterConfigSchema,
]);

// Upper bound for a per-task invoice rate (lamports). 1000 SOL — far above
// any realistic devnet rate; guards against fat-finger / overflow input.
const MAX_TASK_RATE_LAMPORTS = 1_000_000_000_000;

// Shared rate field — flat per-task invoice amount in lamports. `null`
// clears the rate (no auto-invoicing); omitted leaves it unchanged.
const taskRateLamportsSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_TASK_RATE_LAMPORTS)
  .nullable()
  .optional();

// ── Mutations ────────────────────────────────────────────────────────────

// POST /api/agents — initial onboarding (CEO) or subsequent agent.
//
// Discriminated by `adapterType` so the wrong config shape (e.g. openclaw
// `gatewayUrl` against `adapterType: "hermes"`) is rejected by zod before
// it reaches the provision call. Shared fields stay on a base object to
// avoid duplication between the two branches.
const createAgentSharedFields = {
  name: z.string().trim().min(1).max(LIMITS.NAME),
  role: roleSchema,
  // Free-text specialty ("specialist for X"). Intrinsic to the agent,
  // persisted on the identity. Optional.
  persona: z.string().trim().max(LIMITS.DESCRIPTION_SHORT).nullable().optional(),
  // Used only on first-time onboarding (user has no company yet). Ignored
  // when the user already owns a company — agents always attach to the
  // existing one so we never end up with split companies.
  companyName: z.string().trim().min(1).max(LIMITS.NAME).optional(),
  // Optional explicit parent. When omitted / null the server falls back
  // to catalog-driven auto-resolve. Validated against the requester's
  // company in the route handler before insert.
  parentAgentId: z.string().uuid().nullable().optional(),
  // Optional flat per-task invoice rate, set at deploy time.
  taskRateLamports: taskRateLamportsSchema,
};

export const createAgentBody = z.discriminatedUnion("adapterType", [
  z.object({
    ...createAgentSharedFields,
    adapterType: z.literal("openclaw"),
    adapterConfig: openclawAdapterConfigSchema,
  }),
  z.object({
    ...createAgentSharedFields,
    adapterType: z.literal("hermes"),
    adapterConfig: hermesAdapterConfigSchema,
  }),
  z.object({
    ...createAgentSharedFields,
    adapterType: z.literal("claude-code"),
    adapterConfig: claudeCodeAdapterConfigSchema,
  }),
]);

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
  // Flat per-task invoice rate. `null` clears it (no auto-invoicing).
  taskRateLamports: taskRateLamportsSchema,
});

// PATCH /api/agents/:id/files/:filename — edit one workspace file.
// `:filename` is validated against the canonical 8-file set at the route
// level (see WORKSPACE_FILENAMES in lib/workspace-templates).
export const updateAgentFileBody = z.object({
  content: z.string().max(LIMITS.WORKSPACE_FILE_CONTENT),
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

// POST /api/agents/:id/adapter/rotate-bearer
export const rotateBearerBody = z.object({
  apiKey: z.string().min(1).max(LIMITS.API_KEY),
});

// POST /api/agents/:id/adapter/switch
//
// Move an already-deployed agent to a different runtime (e.g. openclaw →
// hermes). Discriminated by the TARGET `adapterType` so the config shape
// is validated for the destination runtime, identical to `createAgentBody`.
// The agent's identity, deployment, hierarchy, seat, and task history are
// untouched — only the runtime backing the deployment changes.
export const switchAdapterBody = z.discriminatedUnion("adapterType", [
  z.object({
    adapterType: z.literal("openclaw"),
    adapterConfig: openclawAdapterConfigSchema,
  }),
  z.object({
    adapterType: z.literal("hermes"),
    adapterConfig: hermesAdapterConfigSchema,
  }),
  z.object({
    adapterType: z.literal("claude-code"),
    adapterConfig: claudeCodeAdapterConfigSchema,
  }),
]);

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
