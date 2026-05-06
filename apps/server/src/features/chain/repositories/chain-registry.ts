import { eq, sql } from "drizzle-orm";
import {
  agentIdentities,
  companies,
  deployments,
} from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

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
 * Persist an updated `operating_wallet` after `set_operating_wallet`
 * confirms on-chain. Lives on the deployment row (per-company), not
 * the identity.
 */
export async function persistAgentOperatingWallet(args: {
  agentId: string;
  operatingWallet: string;
}): Promise<void> {
  await db
    .update(deployments)
    .set({
      operatingWallet: args.operatingWallet,
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
 * Reserve an `agent_index` on a deployment row whose value drifts from
 * the one the prepare flow chose. Used so the FE-signed transaction
 * targets the exact PDA the server assigned.
 *
 * The (company_id, deployment_index) unique index in the DB will throw
 * if two callers race for the same slot — caller should treat that as
 * a collision signal and pick the next one.
 */
export async function reserveAgentIndex(args: {
  agentId: string;
  agentIndex: number;
}): Promise<void> {
  await db
    .update(deployments)
    .set({ deploymentIndex: args.agentIndex, updatedAt: new Date() })
    .where(eq(deployments.id, args.agentId));
}
