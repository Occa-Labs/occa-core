// Company tools — per-company installed tool instances.
//
// The credentials in this table are encrypted at rest (see
// lib/tool-crypto.ts). This repository exposes raw row CRUD; encryption
// and decryption happen at the service / route layer so the repository
// stays thin and doesn't know about the credential plaintext shape.

import { and, eq, sql } from "drizzle-orm";
import {
  agentRuntimeProfile,
  companyTools,
  deployments,
} from "@occa/shared/schema";
import type { AgentRole } from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import type { EncryptedBlob } from "../../../lib/tool-crypto";

export type CompanyToolRow = typeof companyTools.$inferSelect;
export type CompanyToolInsert = typeof companyTools.$inferInsert;

export type CompanyToolStatus = "active" | "paused" | "failed";

export async function listForCompany(
  companyId: string,
): Promise<CompanyToolRow[]> {
  return db
    .select()
    .from(companyTools)
    .where(eq(companyTools.companyId, companyId))
    .orderBy(companyTools.createdAt);
}

export async function findById(id: string): Promise<CompanyToolRow | null> {
  const [row] = await db
    .select()
    .from(companyTools)
    .where(eq(companyTools.id, id))
    .limit(1);
  return row ?? null;
}

export async function findOwnedById(args: {
  id: string;
  companyId: string;
}): Promise<CompanyToolRow | null> {
  const [row] = await db
    .select()
    .from(companyTools)
    .where(
      and(eq(companyTools.id, args.id), eq(companyTools.companyId, args.companyId)),
    )
    .limit(1);
  return row ?? null;
}

export async function insert(args: {
  companyId: string;
  type: string;
  label: string;
  credentialsEncrypted: EncryptedBlob;
  metadata?: Record<string, unknown>;
  allowedRoles?: AgentRole[];
}): Promise<CompanyToolRow> {
  const [row] = await db
    .insert(companyTools)
    .values({
      companyId: args.companyId,
      type: args.type,
      label: args.label,
      credentialsEncrypted: args.credentialsEncrypted,
      metadata: args.metadata ?? {},
      allowedRoles: args.allowedRoles ?? [],
    })
    .returning();
  return row;
}

export async function updateById(args: {
  id: string;
  companyId: string;
  patch: {
    label?: string;
    credentialsEncrypted?: EncryptedBlob;
    metadata?: Record<string, unknown>;
    status?: CompanyToolStatus;
    allowedRoles?: AgentRole[];
    lastError?: string | null;
  };
}): Promise<CompanyToolRow | null> {
  const [row] = await db
    .update(companyTools)
    .set({
      ...(args.patch.label !== undefined ? { label: args.patch.label } : {}),
      ...(args.patch.credentialsEncrypted !== undefined
        ? { credentialsEncrypted: args.patch.credentialsEncrypted }
        : {}),
      ...(args.patch.metadata !== undefined ? { metadata: args.patch.metadata } : {}),
      ...(args.patch.status !== undefined ? { status: args.patch.status } : {}),
      ...(args.patch.allowedRoles !== undefined
        ? { allowedRoles: args.patch.allowedRoles }
        : {}),
      ...(args.patch.lastError !== undefined
        ? { lastError: args.patch.lastError }
        : {}),
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(companyTools.id, args.id), eq(companyTools.companyId, args.companyId)),
    )
    .returning();
  return row ?? null;
}

export async function deleteById(args: {
  id: string;
  companyId: string;
}): Promise<boolean> {
  const result = await db
    .delete(companyTools)
    .where(
      and(eq(companyTools.id, args.id), eq(companyTools.companyId, args.companyId)),
    )
    .returning({ id: companyTools.id });
  return result.length > 0;
}

// Append `toolId` to every eligible deployment's `enabled_tools` array.
// Mirrors broadcastSkillToEligibleAgents in the skills feature so the
// install UX matches what operators already learned from skills:
// importing a tool with empty `allowedRoles` enables it for every agent;
// importing with a restricted list enables it only on role-matching
// agents. Idempotent — agents that already have the id stay untouched.
export async function broadcastToolToEligibleAgents(args: {
  companyId: string;
  toolId: string;
  allowedRoles: AgentRole[];
}): Promise<void> {
  const rows = await db
    .select({
      deploymentId: deployments.id,
      role: deployments.role,
      enabledTools: agentRuntimeProfile.enabledTools,
    })
    .from(deployments)
    .innerJoin(
      agentRuntimeProfile,
      eq(agentRuntimeProfile.deploymentId, deployments.id),
    )
    .where(eq(deployments.companyId, args.companyId));

  const eligible = rows.filter(
    (a) =>
      (args.allowedRoles.length === 0 ||
        args.allowedRoles.includes(a.role as AgentRole)) &&
      !a.enabledTools.includes(args.toolId),
  );
  if (eligible.length === 0) return;

  await Promise.all(
    eligible.map((a) =>
      db
        .update(agentRuntimeProfile)
        .set({
          enabledTools: [...a.enabledTools, args.toolId],
          updatedAt: new Date(),
        })
        .where(eq(agentRuntimeProfile.deploymentId, a.deploymentId)),
    ),
  );
}

// Drop a deleted tool's id from every deployment that still references
// it. Called from the DELETE route so per-agent enabled_tools never
// holds dangling UUIDs.
export async function purgeToolFromEnabledLists(args: {
  companyId: string;
  toolId: string;
}): Promise<void> {
  await db
    .update(agentRuntimeProfile)
    .set({
      enabledTools: sql`array_remove(${agentRuntimeProfile.enabledTools}, ${args.toolId}::uuid)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentRuntimeProfile.companyId, args.companyId),
        sql`${args.toolId}::uuid = ANY(${agentRuntimeProfile.enabledTools})`,
      ),
    );
}
