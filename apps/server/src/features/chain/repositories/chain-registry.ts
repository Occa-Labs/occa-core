import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import {
  agentIdentities,
  companies,
  deployments,
} from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { PG_ERROR_CODES } from "../../../lib/pg-errors";

/**
 * Mutate company row with on-chain cache columns. Idempotent: callers
 * should guard so they don't re-overwrite an already-registered row.
 */
export async function persistCompanyChainRegistration(args: {
  companyId: string;
  companyPda: string;
  ownerWallet: string;
  chainNonce: number;
  chainTxSignature: string;
}): Promise<void> {
  await db
    .update(companies)
    .set({
      companyPda: args.companyPda,
      ownerWallet: args.ownerWallet,
      chainNonce: args.chainNonce,
      chainTxSignature: args.chainTxSignature,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, args.companyId));
}

/**
 * Mutate the deployment row + its identity row with on-chain cache
 * columns after a successful `register_agent` confirmation.
 *
 * The on-chain PDA the chain SDK derives via `deriveAgentPda(companyPda,
 * agentIndex)` is mirrored as `deployments.deployment_pda`; the index
 * lives on `deployments.deployment_index`. `ownerWallet` is upgraded
 * from the placeholder synthesized at deploy time to the real wallet on
 * `agent_identities`.
 */
export async function persistAgentChainRegistration(args: {
  agentId: string;
  agentPda: string;
  agentIndex: number;
  ownerWallet: string;
  agentChainTxSignature: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(deployments)
      .set({
        deploymentPda: args.agentPda,
        deploymentIndex: args.agentIndex,
        chainTxSignature: args.agentChainTxSignature,
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, args.agentId))
      .returning({ identityId: deployments.agentIdentityId });
    if (updated) {
      await tx
        .update(agentIdentities)
        .set({ ownerWallet: args.ownerWallet, updatedAt: new Date() })
        .where(eq(agentIdentities.id, updated.identityId));
    }
  });
}

/**
 * Mutate the identity row with on-chain cache columns after a
 * successful `register_agent_identity` confirmation. Identity is
 * portable (one identity may be deployed to multiple companies later);
 * this writes the chain-side fields ONLY — does NOT touch deployments.
 */
export async function persistIdentityChainRegistration(args: {
  identityId: string;
  agentPubkey: string;
  identityPda: string;
  ownerWallet: string;
  chainTxSignature: string;
}): Promise<void> {
  await db
    .update(agentIdentities)
    .set({
      agentPubkey: args.agentPubkey,
      identityPda: args.identityPda,
      ownerWallet: args.ownerWallet,
      chainTxSignature: args.chainTxSignature,
      updatedAt: new Date(),
    })
    .where(eq(agentIdentities.id, args.identityId));
}

/**
 * Persist an updated `receiving_address` after `set_receiving_address`
 * confirms on-chain. Lives on the deployment row (per-company), not
 * the identity.
 */
export async function persistAgentReceivingAddress(args: {
  agentId: string;
  receivingAddress: string;
}): Promise<void> {
  await db
    .update(deployments)
    .set({
      receivingAddress: args.receivingAddress,
      updatedAt: new Date(),
    })
    .where(eq(deployments.id, args.agentId));
}

/**
 * Next free per-company agent_index. Mirrors the on-chain PDA seed
 * uniqueness — first deployment in a company gets 0.
 */
export async function nextAgentIndex(companyId: string): Promise<number> {
  const [row] = await db
    .select({
      max: sql<number | null>`MAX(${deployments.deploymentIndex})`,
    })
    .from(deployments)
    .where(eq(deployments.companyId, companyId));
  const max = row?.max;
  return max === null || max === undefined ? 0 : Number(max) + 1;
}

/**
 * Per-company deployment_index values already claimed in the DB, excluding
 * the row being anchored. The (company_id, deployment_index) unique index
 * means writing any of these onto another row throws — so the anchor probe
 * must skip them, not just on-chain-occupied slots. Without this the prepare
 * flow can pick an index that's free on chain but taken in the DB cache
 * (drift), then deadlock on the unique violation.
 */
export async function usedDeploymentIndices(args: {
  companyId: string;
  excludeAgentId: string;
}): Promise<Set<number>> {
  const rows = await db
    .select({ idx: deployments.deploymentIndex })
    .from(deployments)
    .where(
      and(
        eq(deployments.companyId, args.companyId),
        ne(deployments.id, args.excludeAgentId),
        isNotNull(deployments.deploymentIndex),
      ),
    );
  return new Set(rows.map((r) => Number(r.idx)));
}

/**
 * Reserve an `agent_index` on a deployment row whose value drifts from
 * the one the prepare flow chose. Used so the FE-signed transaction
 * targets the exact PDA the server assigned.
 *
 * The (company_id, deployment_index) unique index in the DB will throw
 * if two callers race for the same slot — caller should treat that as
 * a collision signal and pick the next one. Returns false on a unique
 * violation instead of throwing, so the request never hangs on an
 * unhandled rejection.
 */
export async function reserveAgentIndex(args: {
  agentId: string;
  agentIndex: number;
}): Promise<boolean> {
  try {
    await db
      .update(deployments)
      .set({ deploymentIndex: args.agentIndex, updatedAt: new Date() })
      .where(eq(deployments.id, args.agentId));
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

// Postgres unique-violation SQLSTATE. A drifted DB cache can collide on
// (company_id, deployment_index) even after the on-chain probe — treat it
// as "pick another index", not a crash. Drizzle wraps the pg error, so the
// SQLSTATE may sit on the error itself or its `cause`.
function isUniqueViolation(err: unknown): boolean {
  const direct = (err as { code?: string }).code;
  const wrapped = (err as { cause?: { code?: string } }).cause?.code;
  return (
    direct === PG_ERROR_CODES.UNIQUE_VIOLATION ||
    wrapped === PG_ERROR_CODES.UNIQUE_VIOLATION
  );
}
