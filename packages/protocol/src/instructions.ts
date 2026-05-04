import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { REGISTRY_PROGRAM_ID } from "./constants";
import { deriveAgentPda, deriveCompanyPda, u32LeBytes } from "./pda";

// Anchor instruction discriminators — copied verbatim from
// `packages/protocol/src/idl/registry.json`. If the program is rebuilt
// with renamed instructions, regen the IDL and update both.
const DISCRIMINATOR = {
  createCompany: Buffer.from([36, 192, 217, 147, 233, 129, 198, 18]),
  registerAgent: Buffer.from([135, 157, 66, 195, 2, 113, 175, 30]),
} as const;

// ── Borsh primitives ────────────────────────────────────────────────────────

function encodeString(s: string): Buffer {
  const utf8 = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(utf8.length, 0);
  return Buffer.concat([len, utf8]);
}

function encodePubkey(pk: PublicKey): Buffer {
  return Buffer.from(pk.toBytes());
}

function encodeU8(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 0xff) {
    throw new RangeError(`u8 out of range: ${n}`);
  }
  return Buffer.from([n]);
}

// ── Instruction builders ────────────────────────────────────────────────────

export interface CreateCompanyParams {
  authority: PublicKey;
  payer: PublicKey;
  nonce: number;
  metadataUri: string;
  programId?: PublicKey;
}

export function buildCreateCompanyInstruction(params: CreateCompanyParams): {
  instruction: TransactionInstruction;
  companyPda: PublicKey;
  bump: number;
} {
  const programId = params.programId ?? REGISTRY_PROGRAM_ID;
  const { pda: companyPda, bump } = deriveCompanyPda(
    params.authority,
    params.nonce,
    programId,
  );

  const data = Buffer.concat([
    DISCRIMINATOR.createCompany,
    u32LeBytes(params.nonce),
    encodeString(params.metadataUri),
  ]);

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: companyPda, isSigner: false, isWritable: true },
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  return { instruction, companyPda, bump };
}

export interface RegisterAgentParams {
  companyPda: PublicKey;
  controllingAuthority: PublicKey;
  payer: PublicKey;
  agentIndex: number;
  agentAddress: PublicKey;
  /** 0=Derived, 1=Custodial, 2=Threshold, 3=SignToDerive (MVP default) */
  custodyModel: number;
  roleId: number;
  /** Pubkey::default() = unspecified; pass `PublicKey.default` if unknown. */
  adapterId: PublicKey;
  programId?: PublicKey;
}

export function buildRegisterAgentInstruction(params: RegisterAgentParams): {
  instruction: TransactionInstruction;
  agentPda: PublicKey;
  bump: number;
} {
  const programId = params.programId ?? REGISTRY_PROGRAM_ID;
  const { pda: agentPda, bump } = deriveAgentPda(
    params.companyPda,
    params.agentIndex,
    programId,
  );

  const data = Buffer.concat([
    DISCRIMINATOR.registerAgent,
    u32LeBytes(params.agentIndex),
    encodePubkey(params.agentAddress),
    encodeU8(params.custodyModel),
    u32LeBytes(params.roleId),
    encodePubkey(params.adapterId),
  ]);

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.companyPda, isSigner: false, isWritable: false },
      {
        pubkey: params.controllingAuthority,
        isSigner: true,
        isWritable: false,
      },
      { pubkey: agentPda, isSigner: false, isWritable: true },
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  return { instruction, agentPda, bump };
}

// On-chain custody_model encoding — must match
// `programs/registry/src/lib.rs` CustodyModel enum. The DB column uses
// strings (sign_to_derive / custodial / threshold); this maps to the u8
// the program expects.
export const CUSTODY_MODEL_ON_CHAIN = {
  Derived: 0,
  Custodial: 1,
  Threshold: 2,
  SignToDerive: 3,
} as const;

export function custodyModelStringToU8(s: string): number {
  switch (s) {
    case "sign_to_derive":
      return CUSTODY_MODEL_ON_CHAIN.SignToDerive;
    case "custodial":
      return CUSTODY_MODEL_ON_CHAIN.Custodial;
    case "threshold":
      return CUSTODY_MODEL_ON_CHAIN.Threshold;
    default:
      throw new Error(`unknown custody model: ${s}`);
  }
}
