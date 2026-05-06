// Deployment API key repository — token table CRUD. Crypto + DTO
// mapping stay in services/deployment-api-keys.ts (not data access).

import { and, eq, isNull } from "drizzle-orm";
import { deploymentApiKeys } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type DeploymentApiKeyRow = typeof deploymentApiKeys.$inferSelect;
export type DeploymentApiKeyInsert = typeof deploymentApiKeys.$inferInsert;

export async function insertKey(
  values: DeploymentApiKeyInsert,
): Promise<DeploymentApiKeyRow> {
  const [row] = await db.insert(deploymentApiKeys).values(values).returning();
  return row;
}

// Returns the bare fields verifyDeploymentKey needs (no full row clone)
// so a hot path doesn't pull metadata it'll discard.
export async function findByHash(hash: string): Promise<
  | {
      id: string;
      deploymentId: string;
      companyId: string;
      keyHash: string;
      revokedAt: Date | null;
    }
  | undefined
> {
  const [row] = await db
    .select({
      id: deploymentApiKeys.id,
      deploymentId: deploymentApiKeys.deploymentId,
      companyId: deploymentApiKeys.companyId,
      keyHash: deploymentApiKeys.keyHash,
      revokedAt: deploymentApiKeys.revokedAt,
    })
    .from(deploymentApiKeys)
    .where(eq(deploymentApiKeys.keyHash, hash))
    .limit(1);
  return row;
}

export async function touchLastUsed(keyId: string): Promise<void> {
  await db
    .update(deploymentApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(deploymentApiKeys.id, keyId));
}

export async function listByDeploymentId(
  deploymentId: string,
): Promise<DeploymentApiKeyRow[]> {
  return db
    .select()
    .from(deploymentApiKeys)
    .where(eq(deploymentApiKeys.deploymentId, deploymentId));
}

// Returns true if a row was actually revoked (false if not found /
// already revoked / not owned by the given deployment).
export async function revokeKey(args: {
  keyId: string;
  deploymentId: string;
}): Promise<boolean> {
  const [row] = await db
    .update(deploymentApiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(deploymentApiKeys.id, args.keyId),
        eq(deploymentApiKeys.deploymentId, args.deploymentId),
        isNull(deploymentApiKeys.revokedAt),
      ),
    )
    .returning({ id: deploymentApiKeys.id });
  return !!row;
}
