import { PublicKey } from "@solana/web3.js";
import { AGENT_SEED, COMPANY_SEED, REGISTRY_PROGRAM_ID } from "./constants";

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
 *   seeds = ["company", controlling_authority, nonce_le_u32]
 *
 * The nonce allows a single controlling_authority to create multiple
 * companies. For MVP, server picks `nonce = 0` for the first company per
 * authority and increments on collision.
 */
export function deriveCompanyPda(
  controllingAuthority: PublicKey,
  nonce: number,
  programId: PublicKey = REGISTRY_PROGRAM_ID,
): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [COMPANY_SEED, controllingAuthority.toBuffer(), u32LeBytes(nonce)],
    programId,
  );
  return { pda, bump };
}

/**
 * AgentAccount PDA.
 *
 *   seeds = ["agent", company_pda, agent_index_le_u32]
 *
 * `agent_index` is a per-company counter (u32), not a UUID. Maintained by
 * the server; first agent uses index = 0.
 */
export function deriveAgentPda(
  companyPda: PublicKey,
  agentIndex: number,
  programId: PublicKey = REGISTRY_PROGRAM_ID,
): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [AGENT_SEED, companyPda.toBuffer(), u32LeBytes(agentIndex)],
    programId,
  );
  return { pda, bump };
}
