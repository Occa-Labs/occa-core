// AgentIdentity repository — Truth tier mirror of on-chain
// `AgentIdentity` PDA. Portable identity, owner-scoped, independent of
// any company. The same identity may be deployed to multiple companies
// owned by the same wallet.

import { and, eq } from "drizzle-orm";
import { agentIdentities } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type AgentIdentityRow = typeof agentIdentities.$inferSelect;
export type AgentIdentityInsert = typeof agentIdentities.$inferInsert;

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
