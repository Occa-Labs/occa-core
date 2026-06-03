// AgentIdentity repository — Truth tier mirror of on-chain
// `AgentIdentity` PDA. Portable identity, owner-scoped, independent of
// any company. The same identity may be deployed to multiple companies
// owned by the same wallet.

import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { agentIdentities, deployments } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type AgentIdentityRow = typeof agentIdentities.$inferSelect;
export type AgentIdentityInsert = typeof agentIdentities.$inferInsert;

export interface MarketplaceAgentRow {
  identityId: string;
  name: string;
  persona: string | null;
  ownerWallet: string;
  ownerUserId: string;
  role: string;
  identityPda: string;
  receivingAddress: string | null;
  createdAt: Date;
}

// Cross-owner marketplace listing: agents whose owner opted in
// (available_for_work), that are anchored on-chain (real identity), and
// currently idle (deployment.companyId IS NULL — not working anywhere).
// Own agents stay in the list (so owners see their agent IS discoverable);
// the caller tags them `isOwn` to suppress the invite action.
export async function listMarketplaceAgents(): Promise<MarketplaceAgentRow[]> {
  return db
    .select({
      identityId: agentIdentities.id,
      name: agentIdentities.name,
      persona: agentIdentities.persona,
      ownerWallet: agentIdentities.ownerWallet,
      ownerUserId: agentIdentities.ownerUserId,
      role: deployments.role,
      identityPda: agentIdentities.identityPda,
      receivingAddress: agentIdentities.receivingAddress,
      createdAt: agentIdentities.createdAt,
    })
    .from(agentIdentities)
    .innerJoin(deployments, eq(deployments.agentIdentityId, agentIdentities.id))
    .where(
      and(
        eq(agentIdentities.availableForWork, true),
        isNotNull(agentIdentities.chainTxSignature),
        isNotNull(agentIdentities.receivingAddress),
        isNull(deployments.companyId),
      ),
    );
}

export async function findById(
  identityId: string,
): Promise<AgentIdentityRow | undefined> {
  const [row] = await db
    .select()
    .from(agentIdentities)
    .where(eq(agentIdentities.id, identityId))
    .limit(1);
  return row;
}

export async function findByAgentPubkey(
  agentPubkey: string,
): Promise<AgentIdentityRow | undefined> {
  const [row] = await db
    .select()
    .from(agentIdentities)
    .where(eq(agentIdentities.agentPubkey, agentPubkey))
    .limit(1);
  return row;
}

export async function findByIdentityPda(
  identityPda: string,
): Promise<AgentIdentityRow | undefined> {
  const [row] = await db
    .select()
    .from(agentIdentities)
    .where(eq(agentIdentities.identityPda, identityPda))
    .limit(1);
  return row;
}

export async function listByOwnerUserId(
  ownerUserId: string,
): Promise<AgentIdentityRow[]> {
  return db
    .select()
    .from(agentIdentities)
    .where(eq(agentIdentities.ownerUserId, ownerUserId));
}

export async function findOwnedByUserId(args: {
  userId: string;
  identityId: string;
}): Promise<AgentIdentityRow | undefined> {
  const [row] = await db
    .select()
    .from(agentIdentities)
    .where(
      and(
        eq(agentIdentities.id, args.identityId),
        eq(agentIdentities.ownerUserId, args.userId),
      ),
    )
    .limit(1);
  return row;
}

export async function insertIdentity(
  values: AgentIdentityInsert,
): Promise<AgentIdentityRow> {
  const [row] = await db.insert(agentIdentities).values(values).returning();
  return row;
}

export async function updateIdentityById(args: {
  identityId: string;
  patch: Partial<AgentIdentityInsert>;
}): Promise<AgentIdentityRow | undefined> {
  const [row] = await db
    .update(agentIdentities)
    .set({ ...args.patch, updatedAt: new Date() })
    .where(eq(agentIdentities.id, args.identityId))
    .returning();
  return row;
}

export async function deleteIdentityById(identityId: string): Promise<void> {
  await db.delete(agentIdentities).where(eq(agentIdentities.id, identityId));
}
