import { PublicKey } from "@solana/web3.js";
import {
  AGENT_IDENTITY_SEED,
  COMPANY_SEED,
  DEPLOYMENT_SEED,
  REGISTRY_PROGRAM_ID,
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
