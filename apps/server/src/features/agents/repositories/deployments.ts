// Deployment repository — Truth tier mirror of on-chain `Deployment`
// PDA, the per-company relation between an AgentIdentity and a Company.
// Replaces the old `agents` table for identity-in-company semantics.
// Runtime/ephemeral fields (provisioning state, adapter config, desired
// skills) live in `agent_runtime_profile` — see ./agent-runtime-profile.

import { and, eq, isNull } from "drizzle-orm";
import { companies, deployments } from "@occa/shared/schema";
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

// Resolve a deployment owned by the given user via their active
// 'user'-kind company. Single round-trip via JOIN. Returns undefined if
// the user has no company OR doesn't own the deployment.
export async function findOwnedByUserId(args: {
  userId: string;
  deploymentId: string;
}): Promise<DeploymentRow | undefined> {
  const [row] = await db
    .select()
    .from(deployments)
    .innerJoin(companies, eq(deployments.companyId, companies.id))
    .where(
      and(
        eq(deployments.id, args.deploymentId),
        eq(companies.ownerUserId, args.userId),
        eq(companies.kind, "user"),
        isNull(companies.deletedAt),
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
    r.deploymentIndex < lo.deploymentIndex ? r : lo,
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
  if (rows.length === 0) return undefined;
  return Math.max(...rows.map((r) => r.idx));
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
