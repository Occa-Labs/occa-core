// Agent API keys — generation, verification, revocation. Crypto + DTO
// mapping live here; raw SQL access is delegated to the repository.

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { AgentApiKeyDTO } from "@occa/shared/types";
import {
  findByHash,
  insertKey,
  listByAgentId,
  revokeKey,
  touchLastUsed,
  type AgentApiKeyRow,
} from "../repositories/agent-api-keys";
import { findById as findAgentById } from "../repositories/agents";

const KEY_PREFIX = "occa_ag_";

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function toAgentApiKeyDTO(row: AgentApiKeyRow): AgentApiKeyDTO {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export async function generateAgentKey(input: {
  agentId: string;
  companyId: string;
  name: string;
}): Promise<{ rawKey: string; row: AgentApiKeyRow }> {
  const raw = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const row = await insertKey({
    agentId: input.agentId,
    companyId: input.companyId,
    name: input.name,
    keyHash: hashKey(raw),
  });
  return { rawKey: raw, row };
}

export interface VerifiedAgentKey {
  keyId: string;
  agentId: string;
  companyId: string;
}

export async function verifyAgentKey(
  rawKey: string,
): Promise<VerifiedAgentKey | null> {
  if (!rawKey.startsWith(KEY_PREFIX)) return null;
  const hash = hashKey(rawKey);
  const row = await findByHash(hash);
  if (!row) return null;
  if (row.revokedAt) return null;

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

  return { keyId: row.id, agentId: row.agentId, companyId: row.companyId };
}

export async function listAgentKeys(
  agentId: string,
): Promise<AgentApiKeyRow[]> {
  return listByAgentId(agentId);
}

export async function revokeAgentKey(input: {
  agentId: string;
  keyId: string;
}): Promise<boolean> {
  return revokeKey(input);
}

// Used by requireAgentToken to hydrate the attached agent context.
export async function getAgentById(agentId: string) {
  return (await findAgentById(agentId)) ?? null;
}
