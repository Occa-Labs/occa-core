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
  controllingAuthority: string;
  chainNonce: number;
  chainTxSignature: string;
}): Promise<void> {
  await db
    .update(companies)
    .set({
      companyPda: args.companyPda,
      controllingAuthority: args.controllingAuthority,
      chainNonce: args.chainNonce,
      chainTxSignature: args.chainTxSignature,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, args.companyId));
}

/**
 * Pick the next free per-authority nonce for create_company. Picks
 * `MAX(chain_nonce) + 1` over rows already registered under this
 * authority; starts at 0 if none.
 */
export async function nextChainNonce(
  controllingAuthority: string,
): Promise<number> {
  const [row] = await db
    .select({
      max: sql<number | null>`MAX(${companies.chainNonce})`,
    })
    .from(companies)
    .where(eq(companies.controllingAuthority, controllingAuthority));
  const max = row?.max;
  return max === null || max === undefined ? 0 : Number(max) + 1;
}

/**
 * Mutate agent row with on-chain cache columns.
 */
export async function persistAgentChainRegistration(args: {
  agentId: string;
  agentPda: string;
  agentAddress: string;
  agentIndex: number;
  custodyModel: string;
  derivationMsgVersion: number;
  agentChainTxSignature: string;
}): Promise<void> {
  await db
    .update(agents)
    .set({
      agentPda: args.agentPda,
      agentAddress: args.agentAddress,
      agentIndex: args.agentIndex,
      custodyModel: args.custodyModel,
      derivationMsgVersion: args.derivationMsgVersion,
      agentChainTxSignature: args.agentChainTxSignature,
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
