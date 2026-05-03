// Agent API key repository — token table CRUD. Crypto + DTO mapping
// stay in services/agent-api-keys.ts (not data access).

import { and, eq, isNull } from "drizzle-orm";
import { agentApiKeys } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type AgentApiKeyRow = typeof agentApiKeys.$inferSelect;
export type AgentApiKeyInsert = typeof agentApiKeys.$inferInsert;

export async function insertKey(
  values: AgentApiKeyInsert,
): Promise<AgentApiKeyRow> {
  const [row] = await db.insert(agentApiKeys).values(values).returning();
  return row;
}

// Returns the bare fields verifyAgentKey needs (no full row clone) so a
// hot path doesn't pull markdown / metadata it'll discard.
export async function findByHash(hash: string): Promise<{
  id: string;
  agentId: string;
  companyId: string;
  keyHash: string;
  revokedAt: Date | null;
} | undefined> {
  const [row] = await db
    .select({
      id: agentApiKeys.id,
      agentId: agentApiKeys.agentId,
      companyId: agentApiKeys.companyId,
      keyHash: agentApiKeys.keyHash,
      revokedAt: agentApiKeys.revokedAt,
    })
    .from(agentApiKeys)
    .where(eq(agentApiKeys.keyHash, hash))
    .limit(1);
  return row;
}

export async function touchLastUsed(keyId: string): Promise<void> {
  await db
    .update(agentApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentApiKeys.id, keyId));
}

export async function listByAgentId(agentId: string): Promise<AgentApiKeyRow[]> {
  return db
    .select()
    .from(agentApiKeys)
    .where(eq(agentApiKeys.agentId, agentId));
}

// Returns true if a row was actually revoked (false if not found / already
// revoked / not owned by the given agent).
export async function revokeKey(args: {
  keyId: string;
  agentId: string;
}): Promise<boolean> {
  const [row] = await db
    .update(agentApiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(agentApiKeys.id, args.keyId),
        eq(agentApiKeys.agentId, args.agentId),
        isNull(agentApiKeys.revokedAt),
      ),
    )
    .returning({ id: agentApiKeys.id });
  return !!row;
}
