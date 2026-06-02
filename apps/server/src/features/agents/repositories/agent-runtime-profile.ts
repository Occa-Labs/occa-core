// Agent runtime profile repository — Ephemeral tier (1:1 with
// deployments). Adapter config, provisioning state, desired skills,
// 3D seating. None of these survive a chain → DB recovery; defaults
// regenerate at provision time.

import { eq, isNull } from "drizzle-orm";
import { agentRuntimeProfile, deployments } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type AgentRuntimeProfileRow = typeof agentRuntimeProfile.$inferSelect;
export type AgentRuntimeProfileInsert =
  typeof agentRuntimeProfile.$inferInsert;

export async function findByDeploymentId(
  deploymentId: string,
): Promise<AgentRuntimeProfileRow | undefined> {
  const [row] = await db
    .select()
    .from(agentRuntimeProfile)
    .where(eq(agentRuntimeProfile.deploymentId, deploymentId))
    .limit(1);
  return row;
}

export async function insertProfile(
  values: AgentRuntimeProfileInsert,
): Promise<AgentRuntimeProfileRow> {
  const [row] = await db
    .insert(agentRuntimeProfile)
    .values(values)
    .returning();
  return row;
}

export async function updateProfileByDeploymentId(args: {
  deploymentId: string;
  patch: Partial<AgentRuntimeProfileInsert>;
}): Promise<AgentRuntimeProfileRow | undefined> {
  const [row] = await db
    .update(agentRuntimeProfile)
    .set({ ...args.patch, updatedAt: new Date() })
    .where(eq(agentRuntimeProfile.deploymentId, args.deploymentId))
    .returning();
  return row;
}

export async function deleteProfileByDeploymentId(
  deploymentId: string,
): Promise<void> {
  await db
    .delete(agentRuntimeProfile)
    .where(eq(agentRuntimeProfile.deploymentId, deploymentId));
}

// ── Skills ───────────────────────────────────────────────────────────

export async function getDesiredSkills(
  deploymentId: string,
): Promise<string[] | undefined> {
  const [row] = await db
    .select({ desiredSkills: agentRuntimeProfile.desiredSkills })
    .from(agentRuntimeProfile)
    .where(eq(agentRuntimeProfile.deploymentId, deploymentId))
    .limit(1);
  return row?.desiredSkills;
}

export async function setDesiredSkills(args: {
  deploymentId: string;
  desiredSkills: string[];
}): Promise<void> {
  await db
    .update(agentRuntimeProfile)
    .set({
      desiredSkills: args.desiredSkills,
      skillsInitializedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(agentRuntimeProfile.deploymentId, args.deploymentId));
}

// `role` lives on `deployments`, so this needs a JOIN to surface the
// fields the skill-init worker expects (matches the old
// `listAgentsAwaitingSkillInit` shape — id is now deploymentId).
export async function listDeploymentsAwaitingSkillInit(): Promise<
  Array<{ id: string; role: string; companyId: string | null }>
> {
  const rows = await db
    .select({
      id: agentRuntimeProfile.deploymentId,
      role: deployments.role,
      companyId: agentRuntimeProfile.companyId,
    })
    .from(agentRuntimeProfile)
    .innerJoin(
      deployments,
      eq(agentRuntimeProfile.deploymentId, deployments.id),
    )
    .where(isNull(agentRuntimeProfile.skillsInitializedAt));
  return rows;
}

// ── Tools ────────────────────────────────────────────────────────────

export async function setEnabledTools(args: {
  deploymentId: string;
  enabledTools: string[];
}): Promise<void> {
  await db
    .update(agentRuntimeProfile)
    .set({
      enabledTools: args.enabledTools,
      updatedAt: new Date(),
    })
    .where(eq(agentRuntimeProfile.deploymentId, args.deploymentId));
}

// ── Provisioning state + adapter wiring ──────────────────────────────

export async function setProvisioningState(args: {
  deploymentId: string;
  state: AgentRuntimeProfileInsert["provisioningState"];
  error?: string | null;
}): Promise<void> {
  const patch: Partial<AgentRuntimeProfileInsert> = {
    provisioningState: args.state,
    updatedAt: new Date(),
  };
  if (args.error !== undefined) patch.provisioningError = args.error;
  await db
    .update(agentRuntimeProfile)
    .set(patch)
    .where(eq(agentRuntimeProfile.deploymentId, args.deploymentId));
}
