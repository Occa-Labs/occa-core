// agent_invites repository — the cross-owner marketplace hire handshake.

import { and, desc, eq } from "drizzle-orm";
import { agentIdentities, agentInvites, companies } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type AgentInviteRow = typeof agentInvites.$inferSelect;

export async function createInvite(values: {
  companyId: string;
  targetIdentityId: string;
  role: string;
  invitedByUserId: string;
}): Promise<AgentInviteRow> {
  const [row] = await db.insert(agentInvites).values(values).returning();
  return row;
}

export async function findInviteById(
  id: string,
): Promise<AgentInviteRow | undefined> {
  const [row] = await db
    .select()
    .from(agentInvites)
    .where(eq(agentInvites.id, id))
    .limit(1);
  return row;
}

export async function setInviteStatus(
  id: string,
  status: string,
): Promise<void> {
  await db
    .update(agentInvites)
    .set({ status, updatedAt: new Date() })
    .where(eq(agentInvites.id, id));
}

// True when there's already a live (pending) invite for this company+agent
// pair — avoids duplicate invites.
export async function hasPendingInvite(args: {
  companyId: string;
  targetIdentityId: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ id: agentInvites.id })
    .from(agentInvites)
    .where(
      and(
        eq(agentInvites.companyId, args.companyId),
        eq(agentInvites.targetIdentityId, args.targetIdentityId),
        eq(agentInvites.status, "pending"),
      ),
    )
    .limit(1);
  return !!row;
}

export interface IncomingInviteRow {
  id: string;
  companyId: string;
  companyName: string;
  targetIdentityId: string;
  agentName: string;
  role: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

// All invites addressed to agents owned by `userId` (the agent owner's
// inbox), joined with the inviting company + agent name for display.
// Resolved invites (accepted/rejected/cancelled) stay in the list as
// history; the UI renders them read-only and the dock badge counts only
// the pending ones.
export async function listIncomingInvites(
  userId: string,
): Promise<IncomingInviteRow[]> {
  return db
    .select({
      id: agentInvites.id,
      companyId: agentInvites.companyId,
      companyName: companies.name,
      targetIdentityId: agentInvites.targetIdentityId,
      agentName: agentIdentities.name,
      role: agentInvites.role,
      status: agentInvites.status,
      createdAt: agentInvites.createdAt,
      updatedAt: agentInvites.updatedAt,
    })
    .from(agentInvites)
    .innerJoin(
      agentIdentities,
      eq(agentInvites.targetIdentityId, agentIdentities.id),
    )
    .innerJoin(companies, eq(agentInvites.companyId, companies.id))
    .where(eq(agentIdentities.ownerUserId, userId))
    .orderBy(desc(agentInvites.updatedAt));
}

// All invites this user SENT (as a company owner), joined with the target
// agent + company name. The sender's "Sent" view: shows whether each
// invite is still pending or was accepted / declined by the agent owner.
export async function listOutgoingInvites(
  userId: string,
): Promise<IncomingInviteRow[]> {
  return db
    .select({
      id: agentInvites.id,
      companyId: agentInvites.companyId,
      companyName: companies.name,
      targetIdentityId: agentInvites.targetIdentityId,
      agentName: agentIdentities.name,
      role: agentInvites.role,
      status: agentInvites.status,
      createdAt: agentInvites.createdAt,
      updatedAt: agentInvites.updatedAt,
    })
    .from(agentInvites)
    .innerJoin(
      agentIdentities,
      eq(agentInvites.targetIdentityId, agentIdentities.id),
    )
    .innerJoin(companies, eq(agentInvites.companyId, companies.id))
    .where(eq(agentInvites.invitedByUserId, userId))
    .orderBy(desc(agentInvites.updatedAt));
}
