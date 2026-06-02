// Deployment repository — Truth tier mirror of on-chain `Deployment`
// PDA, the per-company relation between an AgentIdentity and a Company.
// Replaces the old `agents` table for identity-in-company semantics.
// Runtime/ephemeral fields (provisioning state, adapter config, desired
// skills) live in `agent_runtime_profile` — see ./agent-runtime-profile.

import { and, eq, isNull } from "drizzle-orm";
import { agentIdentities, companies, deployments } from "@occa/shared/schema";
import { getTier } from "@occa/shared/role-catalog";
import { db } from "../../../infra/database/client";

export type DeploymentRow = typeof deployments.$inferSelect;
export type DeploymentInsert = typeof deployments.$inferInsert;

export async function findById(
  deploymentId: string,
): Promise<DeploymentRow | undefined> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  return row;
}

// Resolve a deployment owned by the given company. Used wherever a
// route handler needs the (userId → companyId → deploymentId) ownership
// check.
export async function findByIdInCompany(args: {
  deploymentId: string;
  companyId: string;
}): Promise<DeploymentRow | undefined> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.id, args.deploymentId),
        eq(deployments.companyId, args.companyId),
      ),
    )
    .limit(1);
  return row;
}

// Resolve a deployment owned by the given user via the AGENT IDENTITY
// owner (not the company). Agents are user-owned and independent: this
// works whether the agent is idle (companyId NULL) or working at any
// company. Returns undefined if the user doesn't own the deployment.
export async function findOwnedByUserId(args: {
  userId: string;
  deploymentId: string;
}): Promise<DeploymentRow | undefined> {
  const [row] = await db
    .select()
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(
      and(
        eq(deployments.id, args.deploymentId),
        eq(agentIdentities.ownerUserId, args.userId),
      ),
    )
    .limit(1);
  return row?.deployments;
}

export async function findByPda(
  deploymentPda: string,
): Promise<DeploymentRow | undefined> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.deploymentPda, deploymentPda))
    .limit(1);
  return row;
}

export async function listByCompanyId(
  companyId: string,
): Promise<DeploymentRow[]> {
  return db
    .select()
    .from(deployments)
    .where(eq(deployments.companyId, companyId));
}

// Resolve the active deployment in `companyId` whose role matches `role`.
// CEO uses this to route a CREATE_TASK directly to a specialist named in
// the chat marker (`assignToRole`). Returns the lowest deploymentIndex
// when multiple actives share a role; undefined when none exist.
export async function findActiveByRoleInCompany(args: {
  companyId: string;
  role: string;
}): Promise<DeploymentRow | undefined> {
  const rows = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.companyId, args.companyId),
        eq(deployments.role, args.role),
        eq(deployments.status, "active"),
      ),
    );
  if (rows.length === 0) return undefined;
  return rows.reduce((lo, r) =>
    (r.deploymentIndex ?? 0) < (lo.deploymentIndex ?? 0) ? r : lo,
  );
}

// Resolve the company's CEO deployment by consulting the role catalog for
// `tier:"ceo"`. Single CEO is enforced by the catalog (only one entry has
// the `ceo` tier), but if multiple `active` deployments share the role —
// e.g. a stale duplicate — we return the lowest deploymentIndex (= oldest)
// for deterministic routing. Returns undefined when no active CEO exists;
// callers (Phase 2 task entry lock) surface that as `NO_CEO_DEPLOYED`.
export async function findCeoForCompany(
  companyId: string,
): Promise<DeploymentRow | undefined> {
  const rows = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.companyId, companyId),
        eq(deployments.status, "active"),
      ),
    );
  const ceos = rows.filter((r) => getTier(r.role) === "ceo");
  if (ceos.length === 0) return undefined;
  return ceos.reduce((lo, r) =>
    (r.deploymentIndex ?? 0) < (lo.deploymentIndex ?? 0) ? r : lo,
  );
}

export async function listByAgentIdentityId(
  agentIdentityId: string,
): Promise<DeploymentRow[]> {
  return db
    .select()
    .from(deployments)
    .where(eq(deployments.agentIdentityId, agentIdentityId));
}

// Highest existing deployment_index for a company. Caller +1's it to
// pick the next per-company u32 PDA seed at create time.
export async function maxDeploymentIndexForCompany(
  companyId: string,
): Promise<number | undefined> {
  const rows = await db
    .select({ idx: deployments.deploymentIndex })
    .from(deployments)
    .where(eq(deployments.companyId, companyId));
  const idxs = rows
    .map((r) => r.idx)
    .filter((n): n is number => n !== null);
  if (idxs.length === 0) return undefined;
  return Math.max(...idxs);
}

export async function insertDeployment(
  values: DeploymentInsert,
): Promise<DeploymentRow> {
  const [row] = await db.insert(deployments).values(values).returning();
  return row;
}

export async function updateDeploymentById(args: {
  deploymentId: string;
  patch: Partial<DeploymentInsert>;
}): Promise<DeploymentRow | undefined> {
  const [row] = await db
    .update(deployments)
    .set({ ...args.patch, updatedAt: new Date() })
    .where(eq(deployments.id, args.deploymentId))
    .returning();
  return row;
}

// Status transitions are gated by the on-chain `update_deployment_status`
// ix; this is the DB-side cache update (called after tx confirmation per
// "chain = truth, DB = cache" rule in CLAUDE.md).
export async function setStatus(args: {
  deploymentId: string;
  status: "active" | "paused" | "retired";
}): Promise<void> {
  await db
    .update(deployments)
    .set({ status: args.status, updatedAt: new Date() })
    .where(eq(deployments.id, args.deploymentId));
}

export async function deleteDeploymentById(
  deploymentId: string,
): Promise<void> {
  await db.delete(deployments).where(eq(deployments.id, deploymentId));
}
