import { PublicKey } from "@solana/web3.js";
import {
  AGENT_IDENTITY_SEED,
  COMPANY_SEED,
  DAILY_ANCHOR_SEED,
  DEPLOYMENT_SEED,
  OPERATIONS_SEED,
  POLICY_SEED,
  PROTOCOL_FEES_SEED,
  REGISTRY_PROGRAM_ID,
  TRACE_SEED,
  TREASURY_PROGRAM_ID,
  TREASURY_SEED,
  type OperationsKind,
} from "./constants";

/**
 * Encode a u32 as little-endian 4 bytes (matches Anchor / Borsh on-chain
 * representation when using a u32 in a PDA seed).
 */
export function u32LeBytes(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xff_ff_ff_ff) {
    throw new RangeError(`u32 out of range: ${value}`);
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

/**
 * CompanyAccount PDA.
 *
 *   seeds = ["company", owner, nonce_le_u32]
 *
 * Wallet-bound seed: a wallet's companies can be enumerated directly
 * from chain by probing `(owner, nonce=0..N)`. The owner is also the
 * sole authority for state-changing ix on this account.
 */
export function deriveCompanyPda(
  owner: PublicKey,
  nonce: number,
  programId: PublicKey = REGISTRY_PROGRAM_ID,
): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [COMPANY_SEED, owner.toBuffer(), u32LeBytes(nonce)],
    programId,
  );
  return { pda, bump };
}

/**
 * AgentIdentity PDA.
 *
 *   seeds = ["agent_identity", agent_pubkey]
 *
 * `agent_pubkey` is a stable identity key chosen by the caller (typically
 * a fresh keypair generated client-side). Identity is independent of any
 * company — the same identity may be deployed multiple times across the
 * same owner's companies.
 */
export function deriveAgentIdentityPda(
  agentPubkey: PublicKey,
  programId: PublicKey = REGISTRY_PROGRAM_ID,
): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [AGENT_IDENTITY_SEED, agentPubkey.toBuffer()],
    programId,
  );
  return { pda, bump };
}

/**
 * Deployment PDA.
 *
 *   seeds = ["deployment", company_pda, deployment_index_le_u32]
 *
 * `deployment_index` is a per-company u32 counter. Maintained by the
 * caller — pick the next free index. Same `agent_identity` may have
 * multiple deployments under the same company (e.g. retired then
 * re-deployed); each deployment gets its own index.
 */
export function deriveDeploymentPda(
  companyPda: PublicKey,
  deploymentIndex: number,
  programId: PublicKey = REGISTRY_PROGRAM_ID,
): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [DEPLOYMENT_SEED, companyPda.toBuffer(), u32LeBytes(deploymentIndex)],
    programId,
  );
  return { pda, bump };
}

/**
 * TreasuryAccount PDA — owned by Treasury program.
 *
 *   seeds = ["treasury", company_pda]
 *
 * Initialized atomically with PolicyAccount via Registry's `create_company`
 * CPI to `treasury::init_treasury` (design doc §6).
 */
export function deriveTreasuryPda(
  companyPda: PublicKey,
  programId: PublicKey = TREASURY_PROGRAM_ID,
): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [TREASURY_SEED, companyPda.toBuffer()],
    programId,
  );
  return { pda, bump };
}

/**
 * PolicyAccount PDA — owned by Treasury program.
 *
 *   seeds = ["policy", company_pda]
 *
 * Initialized atomically with TreasuryAccount via the same `create_company`
 * CPI flow.
 */
export function derivePolicyPda(
  companyPda: PublicKey,
  programId: PublicKey = TREASURY_PROGRAM_ID,
): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [POLICY_SEED, companyPda.toBuffer()],
    programId,
  );
  return { pda, bump };
}

/**
 * ProtocolFeeAccount PDA — owned by Treasury program. Singleton: one
 * per program deployment, collects the Agent Operating Fee from every
 * intra-company agent disbursement.
 *
 *   seeds = ["protocol_fees"]
 */
export function deriveProtocolFeePda(
  programId: PublicKey = TREASURY_PROGRAM_ID,
): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [PROTOCOL_FEES_SEED],
    programId,
  );
  return { pda, bump };
}

/**
 * OperationsAccount PDA — owned by Treasury program. One per
 * (company, kind) pair, so Disbursement and Anchor capabilities never
 * share a key.
 *
 *   seeds = ["operations", company_pda, kind_byte]
 *
 * `kind_byte` is the single-byte discriminator from `OPERATIONS_KIND`
 * (Disbursement=0, Anchor=1). Order MUST NOT change once any account
 * exists.
 */
export function deriveOperationsPda(
  companyPda: PublicKey,
  kind: OperationsKind,
  programId: PublicKey = TREASURY_PROGRAM_ID,
): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [OPERATIONS_SEED, companyPda.toBuffer(), Buffer.from([kind])],
    programId,
  );
  return { pda, bump };
}

/** Encode an i64 as little-endian 8 bytes (matches Anchor / Borsh). */
function i64LeBytes(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(value, 0);
  return buf;
}

/**
 * DailyAnchorAccount PDA — owned by Registry program. One per
 * (deployment, UTC day) — captures the Merkle root over that day's
 * task hashes.
 *
 *   seeds = ["daily_anchor", deployment_pda, day_unix_le_i64]
 *
 * `dayUnix` must be aligned to 00:00:00 UTC (multiple of 86400). The
 * on-chain handler enforces alignment; passing an unaligned value will
 * fail with a constraint error.
 */
export function deriveDailyAnchorPda(
  deploymentPda: PublicKey,
  dayUnix: bigint,
  programId: PublicKey = REGISTRY_PROGRAM_ID,
): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [DAILY_ANCHOR_SEED, deploymentPda.toBuffer(), i64LeBytes(dayUnix)],
    programId,
  );
  return { pda, bump };
}

/**
 * TraceAnchorAccount PDA — owned by Registry program. One per completed,
 * verified deliverable (article, PR, etc).
 *
 *   seeds = ["trace", task_id_32bytes]
 *
 * `taskId` is a 32-byte hash of the task creation params. Collision on the
 * same `taskId` means the task is already anchored — a re-commit fails
 * naturally (Anchor `init` rejects).
 */
export function deriveTraceAnchorPda(
  taskId: Uint8Array,
  programId: PublicKey = REGISTRY_PROGRAM_ID,
): { pda: PublicKey; bump: number } {
  if (taskId.length !== 32) {
    throw new RangeError(`taskId must be 32 bytes, got ${taskId.length}`);
  }
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [TRACE_SEED, Buffer.from(taskId)],
    programId,
  );
  return { pda, bump };
}
