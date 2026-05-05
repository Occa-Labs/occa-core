import { eq, sql } from "drizzle-orm";
import { agents, companies } from "@occa/shared/schema";
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
 * Mutate agent row with on-chain cache columns after a successful
 * `register_agent` confirmation.
 */
export async function persistAgentChainRegistration(args: {
  agentId: string;
  agentPda: string;
  agentIndex: number;
  ownerWallet: string;
  agentChainTxSignature: string;
}): Promise<void> {
  await db
    .update(agents)
    .set({
      agentPda: args.agentPda,
      agentIndex: args.agentIndex,
      ownerWallet: args.ownerWallet,
      agentChainTxSignature: args.agentChainTxSignature,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, args.agentId));
}

/**
 * Persist an updated `operating_wallet` after `set_operating_wallet`
 * confirms on-chain.
 */
export async function persistAgentOperatingWallet(args: {
  agentId: string;
  operatingWallet: string;
}): Promise<void> {
  await db
    .update(agents)
    .set({
      operatingWallet: args.operatingWallet,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, args.agentId));
}

/**
 * Next free per-company agent_index. Mirrors the on-chain PDA seed
 * uniqueness — first agent in a company gets 0.
 */
export async function nextAgentIndex(companyId: string): Promise<number> {
  const [row] = await db
    .select({
      max: sql<number | null>`MAX(${agents.agentIndex})`,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const max = row?.max;
  return max === null || max === undefined ? 0 : Number(max) + 1;
}

/**
 * Reserve an `agent_index` on a row that does not yet have one. Used by
 * the prepare flow so the FE-signed transaction targets the exact PDA
 * the server assigned.
 *
 * The (company_id, agent_index) unique index in the DB will throw if
 * two callers race for the same slot — caller should treat that as a
 * collision signal and pick the next one.
 */
export async function reserveAgentIndex(args: {
  agentId: string;
  agentIndex: number;
}): Promise<void> {
  await db
    .update(agents)
    .set({ agentIndex: args.agentIndex, updatedAt: new Date() })
    .where(eq(agents.id, args.agentId));
}
