import { and, eq, isNull } from "drizzle-orm";
import { agents, companies } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type AgentRow = typeof agents.$inferSelect;
export type AgentInsert = typeof agents.$inferInsert;

// ── Lookups ──────────────────────────────────────────────────────────────

export async function findById(agentId: string): Promise<AgentRow | undefined> {
  const [row] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return row;
}

// Resolve an agent owned by the given company. Used everywhere a route
// handler needs the (userId → companyId → agentId) ownership check.
export async function findByIdInCompany(args: {
  agentId: string;
  companyId: string;
}): Promise<AgentRow | undefined> {
  const [row] = await db
    .select()
    .from(agents)
    .where(
      and(eq(agents.id, args.agentId), eq(agents.companyId, args.companyId)),
    )
    .limit(1);
  return row;
}

// Resolve an agent owned by the given user via their active 'user'-kind
// company. Single round-trip via JOIN — replaces the old route-local
// `findForUser` helper that did two queries (companyId lookup, then
// agent fetch). Returns undefined if the user has no company OR doesn't
// own the agent.
export async function findOwnedByUserId(args: {
  userId: string;
  agentId: string;
}): Promise<AgentRow | undefined> {
  const [row] = await db
    .select()
    .from(agents)
    .innerJoin(companies, eq(agents.companyId, companies.id))
    .where(
      and(
        eq(agents.id, args.agentId),
        eq(companies.ownerUserId, args.userId),
        eq(companies.kind, "user"),
        isNull(companies.deletedAt),
      ),
    )
    .limit(1);
  return row?.agents;
}

export async function listByCompanyId(companyId: string): Promise<AgentRow[]> {
  return db.select().from(agents).where(eq(agents.companyId, companyId));
}

// ── Skill-related (already used by agent-skill-assign) ───────────────────

export async function getDesiredSkills(
  agentId: string,
): Promise<string[] | undefined> {
  const [row] = await db
    .select({ desiredSkills: agents.desiredSkills })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return row?.desiredSkills;
}

export async function setDesiredSkills(args: {
  agentId: string;
  desiredSkills: string[];
}): Promise<void> {
  await db
    .update(agents)
    .set({
      desiredSkills: args.desiredSkills,
      skillsInitializedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(agents.id, args.agentId));
}

export async function listAgentsAwaitingSkillInit(): Promise<
  Array<{ id: string; role: string; companyId: string }>
> {
  return db
    .select({
      id: agents.id,
      role: agents.role,
      companyId: agents.companyId,
    })
    .from(agents)
    .where(isNull(agents.skillsInitializedAt));
}

// ── Mutations ────────────────────────────────────────────────────────────

export async function insertAgent(values: AgentInsert): Promise<AgentRow> {
  const [row] = await db.insert(agents).values(values).returning();
  return row;
}

export async function updateAgentById(args: {
  agentId: string;
  patch: Partial<AgentInsert>;
}): Promise<AgentRow | undefined> {
  const [row] = await db
    .update(agents)
    .set({ ...args.patch, updatedAt: new Date() })
    .where(eq(agents.id, args.agentId))
    .returning();
  return row;
}

export async function deleteAgentById(agentId: string): Promise<void> {
  await db.delete(agents).where(eq(agents.id, agentId));
}

// Persist OpenClaw provisioning result onto the agent row. Merges the
// returned IDs into adapter_config (preserving the existing config like
// gatewayUrl/apiKey/deviceKeypair).
export async function persistProvisionResult(args: {
  agentId: string;
  externalAgentId: string;
  workspacePath: string;
  deviceToken?: string;
  existingAdapterConfig: Record<string, unknown>;
}): Promise<void> {
  await db
    .update(agents)
    .set({
      externalAgentId: args.externalAgentId,
      adapterConfig: {
        ...args.existingAdapterConfig,
        ...(args.deviceToken ? { deviceToken: args.deviceToken } : {}),
        openclawAgentId: args.externalAgentId,
        workspacePath: args.workspacePath,
      },
      updatedAt: new Date(),
    })
    .where(eq(agents.id, args.agentId));
}

export async function setProvisioningState(args: {
  agentId: string;
  state: AgentInsert["provisioningState"];
  error?: string | null;
}): Promise<void> {
  const patch: Partial<AgentInsert> = {
    provisioningState: args.state,
    updatedAt: new Date(),
  };
  if (args.error !== undefined) patch.provisioningError = args.error;
  await db.update(agents).set(patch).where(eq(agents.id, args.agentId));
}
