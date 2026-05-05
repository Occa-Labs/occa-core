import { PublicKey } from "@solana/web3.js";
import { REGISTRY_PROGRAM_ID } from "occa-sdk";
import { getConnection } from "../../../infra/solana/connection";
import { childLogger } from "../../../lib/logger";

const log = childLogger("chain:lookup");

// Borsh layout offsets for the registry program's account types. Both are
// fixed-size up to the trailing variable-length string in CompanyAccount,
// so byte-slicing decoders are safe and avoid pulling Anchor's runtime
// just to decode two structs.
//
// AgentAccount  (raw bytes including 8-byte discriminator)
//   0   discriminator (8)
//   8   version (1)
//   9   company pubkey (32)
//   41  agent_address pubkey (32)   ← memcmp target
//   73  custody_model (1)
//   74  derivation_index u32 LE (4)
//   78  agent_index u32 LE (4)
//   82  role_id u32 LE (4)
//   86  adapter_id pubkey (32)
//   118 status (1)
const AGENT_OFFSET_COMPANY = 9;
const AGENT_OFFSET_AGENT_ADDRESS = 41;
const AGENT_OFFSET_CUSTODY_MODEL = 73;
const AGENT_OFFSET_AGENT_INDEX = 78;
const AGENT_FIXED_LEN = 119;

// CompanyAccount (raw bytes including 8-byte discriminator)
//   0   discriminator (8)
//   8   version (1)
//   9   controlling_authority pubkey (32)
//   41  treasury pubkey (32)
//   73  policy pubkey (32)
//   105 created_at i64 LE (8)
//   113 nonce u32 LE (4)
//   117 metadata_uri (string: 4-byte u32 LE length + UTF-8 bytes)
const COMPANY_OFFSET_CONTROLLING_AUTHORITY = 9;
const COMPANY_OFFSET_NONCE = 113;
const COMPANY_MIN_LEN = 117 + 4;

export interface OnChainAgent {
  agentPda: PublicKey;
  company: PublicKey;
  agentAddress: PublicKey;
  agentIndex: number;
  custodyModel: number;
}

export interface OnChainCompany {
  companyPda: PublicKey;
  controllingAuthority: PublicKey;
  nonce: number;
}

/**
 * Find an AgentAccount whose `agent_address` field equals the given
 * wallet. Returns null if none found.
 *
 * Uses `getProgramAccounts` with `dataSize` + `memcmp` filters at the
 * agent_address byte offset — RPC evaluates server-side, no full-state
 * scan-and-decode round trip.
 *
 * Multiple matches: returns the first by RPC iteration order. By PDA
 * seed construction (`["agent", company_pda, agent_index]`) a wallet can
 * be the `agent_address` of at most one agent per company, but in theory
 * could appear under multiple companies. We log a warning so callers
 * know reuse is non-deterministic in that edge case.
 */
export async function findAgentByWallet(
  userWallet: PublicKey,
): Promise<OnChainAgent | null> {
  const conn = getConnection();
  const accounts = await conn.getProgramAccounts(REGISTRY_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { dataSize: AGENT_FIXED_LEN },
      {
        memcmp: {
          offset: AGENT_OFFSET_AGENT_ADDRESS,
          bytes: userWallet.toBase58(),
        },
      },
    ],
  });

  if (accounts.length === 0) return null;
  if (accounts.length > 1) {
    log.warn(
      {
        wallet: userWallet.toBase58(),
        count: accounts.length,
        pdas: accounts.map((a) => a.pubkey.toBase58()),
      },
      "wallet has multiple AgentAccounts on-chain; reusing first",
    );
  }

  const { pubkey, account } = accounts[0];
  const data = account.data;

  // Defensive: dataSize filter already pinned length, but verify before
  // slicing so a future schema bump doesn't silently misdecode.
  if (data.length < AGENT_FIXED_LEN) {
    log.error(
      { pda: pubkey.toBase58(), len: data.length },
      "AgentAccount unexpected size; ignoring",
    );
    return null;
  }

  return {
    agentPda: pubkey,
    company: new PublicKey(
      data.subarray(AGENT_OFFSET_COMPANY, AGENT_OFFSET_COMPANY + 32),
    ),
    agentAddress: new PublicKey(
      data.subarray(
        AGENT_OFFSET_AGENT_ADDRESS,
        AGENT_OFFSET_AGENT_ADDRESS + 32,
      ),
    ),
    custodyModel: data.readUInt8(AGENT_OFFSET_CUSTODY_MODEL),
    agentIndex: data.readUInt32LE(AGENT_OFFSET_AGENT_INDEX),
  };
}

/**
 * Fetch and decode a CompanyAccount by PDA. Returns null if the account
 * doesn't exist or doesn't belong to the registry program.
 */
export async function fetchCompany(
  companyPda: PublicKey,
): Promise<OnChainCompany | null> {
  const conn = getConnection();
  const info = await conn.getAccountInfo(companyPda, "confirmed");
  if (!info) return null;
  if (!info.owner.equals(REGISTRY_PROGRAM_ID)) {
    log.warn(
      {
        pda: companyPda.toBase58(),
        owner: info.owner.toBase58(),
      },
      "fetchCompany: account not owned by registry program",
    );
    return null;
  }
  const data = info.data;
  if (data.length < COMPANY_MIN_LEN) {
    log.error(
      { pda: companyPda.toBase58(), len: data.length },
      "CompanyAccount too small; ignoring",
    );
    return null;
  }
  return {
    companyPda,
    controllingAuthority: new PublicKey(
      data.subarray(
        COMPANY_OFFSET_CONTROLLING_AUTHORITY,
        COMPANY_OFFSET_CONTROLLING_AUTHORITY + 32,
      ),
    ),
    nonce: data.readUInt32LE(COMPANY_OFFSET_NONCE),
  };
}
