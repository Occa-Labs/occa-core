// Deployment API keys — generation, verification, revocation. Crypto +
// DTO mapping live here; raw SQL access is delegated to the repository.

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { AgentApiKeyDTO } from "@occa/shared/types";
import {
  findByHash,
  insertKey,
  listByDeploymentId,
  revokeKey,
  touchLastUsed,
  type DeploymentApiKeyRow,
} from "../repositories/deployment-api-keys";
import { findById as findDeploymentById } from "../repositories/deployments";

const KEY_PREFIX = "occa_ag_";

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// Wire shape still uses `agentId` field name pending the shared/types
// migration in the domain step. The value is the deployment UUID — same
// identifier exposed to the web as "agentId" everywhere else.
export function toDeploymentApiKeyDTO(row: DeploymentApiKeyRow): AgentApiKeyDTO {
  return {
    id: row.id,
    agentId: row.deploymentId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export async function generateDeploymentKey(input: {
  deploymentId: string;
  companyId: string;
  name: string;
  // Absolute expiry. Per-trace dispatcher keys set this 30 min out so a
  // leaked key from gateway conversation history can only be replayed
  // briefly. Omit for long-lived operator keys.
  expiresAt?: Date;
}): Promise<{ rawKey: string; row: DeploymentApiKeyRow }> {
  const raw = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const row = await insertKey({
    deploymentId: input.deploymentId,
    companyId: input.companyId,
    name: input.name,
    keyHash: hashKey(raw),
    expiresAt: input.expiresAt,
  });
  return { rawKey: raw, row };
}

export interface VerifiedDeploymentKey {
  keyId: string;
  deploymentId: string;
  companyId: string;
}

export async function verifyDeploymentKey(
  rawKey: string,
): Promise<VerifiedDeploymentKey | null> {
  if (!rawKey.startsWith(KEY_PREFIX)) return null;
  const hash = hashKey(rawKey);
  const row = await findByHash(hash);
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  // Constant-time hash compare guards against length-leak attacks. We
  // already filtered by hash above, so this is belt-and-suspenders for
  // the (vanishingly unlikely) hash collision case.
  const a = Buffer.from(row.keyHash);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Async last-used touch; don't await. Best effort — failure is fine.
  void touchLastUsed(row.id).catch(() => {
    /* swallow */
  });

  return {
    keyId: row.id,
    deploymentId: row.deploymentId,
    companyId: row.companyId,
  };
}

export async function listDeploymentKeys(
  deploymentId: string,
): Promise<DeploymentApiKeyRow[]> {
  return listByDeploymentId(deploymentId);
}

export async function revokeDeploymentKey(input: {
  deploymentId: string;
  keyId: string;
}): Promise<boolean> {
  return revokeKey(input);
}

// Used by requireAgentToken to hydrate the attached deployment context.
export async function getDeploymentById(deploymentId: string) {
  return (await findDeploymentById(deploymentId)) ?? null;
}
