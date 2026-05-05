import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { REGISTRY_PROGRAM_ID } from "./constants";
import {
  deriveAgentIdentityPda,
  deriveCompanyPda,
  deriveDeploymentPda,
  u32LeBytes,
} from "./pda";

// Anchor instruction discriminators — copied verbatim from
// `packages/occa-sdk/src/idl/registry.json`. If the program is rebuilt
// with renamed instructions, regen the IDL and update both.
//
// Authority model: every state-changing ix is signed by `owner` (the
// user wallet). The operator hot wallet sponsors fees only — it never
// appears as a signer authority on any account.
export const INSTRUCTION_DISCRIMINATOR = {
  createCompany: Buffer.from([36, 192, 217, 147, 233, 129, 198, 18]),
  updateCompanyMetadata: Buffer.from([186, 229, 190, 16, 234, 141, 170, 89]),
  updateCompanyStatus: Buffer.from([61, 6, 101, 120, 141, 13, 125, 75]),
  registerAgentIdentity: Buffer.from([57, 31, 242, 205, 57, 129, 123, 35]),
  updateAgentIdentityMetadata: Buffer.from([
    250, 182, 24, 200, 201, 147, 60, 183,
  ]),
  createDeployment: Buffer.from([55, 207, 186, 101, 21, 218, 102, 171]),
  updateDeploymentMetadata: Buffer.from([100, 135, 41, 32, 16, 41, 29, 76]),
  updateDeploymentStatus: Buffer.from([225, 195, 150, 254, 178, 203, 53, 147]),
  retireDeployment: Buffer.from([45, 188, 162, 197, 136, 180, 202, 153]),
  setOperatingWallet: Buffer.from([20, 151, 94, 114, 217, 30, 52, 132]),
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

function encodeMetadataHash(hash: Uint8Array | Buffer): Buffer {
  if (hash.length !== 32) {
    throw new RangeError(`metadata_hash must be 32 bytes, got ${hash.length}`);
  }
  return Buffer.from(hash);
}

/** Borsh `Option<u32>` = 1-byte tag (0=None, 1=Some) + optional 4-byte LE. */
function encodeOptionU32(value: number | null | undefined): Buffer {
  if (value === null || value === undefined) {
    return Buffer.from([0]);
  }
  return Buffer.concat([Buffer.from([1]), u32LeBytes(value)]);
}

// ── Company ────────────────────────────────────────────────────────────────

export interface CreateCompanyParams {
  /** User wallet — signer + bound into the PDA seed. Sole authority for
   * every state-changing ix on this company. Immutable. */
  owner: PublicKey;
  /** Rent payer. Typically the operator hot wallet (sponsored UX),
   * but may equal `owner`. */
  payer: PublicKey;
  nonce: number;
  name: string;
  /** BCP-47 locale tag (e.g. "en", "id"). Empty string allowed. */
  locale: string;
  /** Off-chain metadata pointer (IPFS / Arweave / HTTPS). */
  metadataUri: string;
  /** SHA-256 of canonical metadata JSON (32 bytes). Pass `Buffer.alloc(32)`
   * if metadata not yet finalized. */
  metadataHash: Uint8Array | Buffer;
  programId?: PublicKey;
}

export function buildCreateCompanyInstruction(params: CreateCompanyParams): {
  instruction: TransactionInstruction;
  companyPda: PublicKey;
  bump: number;
} {
  const programId = params.programId ?? REGISTRY_PROGRAM_ID;
  const { pda: companyPda, bump } = deriveCompanyPda(
    params.owner,
    params.nonce,
    programId,
  );

  const data = Buffer.concat([
    INSTRUCTION_DISCRIMINATOR.createCompany,
    u32LeBytes(params.nonce),
    encodeString(params.name),
    encodeString(params.locale),
    encodeString(params.metadataUri),
    encodeMetadataHash(params.metadataHash),
  ]);

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: companyPda, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  return { instruction, companyPda, bump };
}

export interface UpdateCompanyMetadataParams {
  companyPda: PublicKey;
  /** User wallet — must equal `company.owner`. */
  owner: PublicKey;
  name: string;
  locale: string;
  metadataUri: string;
  metadataHash: Uint8Array | Buffer;
  programId?: PublicKey;
}

export function buildUpdateCompanyMetadataInstruction(
  params: UpdateCompanyMetadataParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? REGISTRY_PROGRAM_ID;
  const data = Buffer.concat([
    INSTRUCTION_DISCRIMINATOR.updateCompanyMetadata,
    encodeString(params.name),
    encodeString(params.locale),
    encodeString(params.metadataUri),
    encodeMetadataHash(params.metadataHash),
  ]);
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.companyPda, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
  return { instruction };
}

export interface UpdateCompanyStatusParams {
  companyPda: PublicKey;
  owner: PublicKey;
  /** 0 = Active, 1 = Paused. See `COMPANY_STATUS`. */
  newStatus: number;
  programId?: PublicKey;
}

export function buildUpdateCompanyStatusInstruction(
  params: UpdateCompanyStatusParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? REGISTRY_PROGRAM_ID;
  const data = Buffer.concat([
    INSTRUCTION_DISCRIMINATOR.updateCompanyStatus,
    encodeU8(params.newStatus),
  ]);
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.companyPda, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
  return { instruction };
}

// ── Agent Identity ─────────────────────────────────────────────────────────

export interface RegisterAgentIdentityParams {
  /** Stable identity key — typically a fresh keypair pubkey held by the
   * user wallet (NOT the user wallet itself). Baked into the PDA seed. */
  agentPubkey: PublicKey;
  /** Owning user wallet. Immutable — there is no transfer instruction. */
  owner: PublicKey;
  /** Rent payer (typically operator hot wallet). */
  payer: PublicKey;
  name: string;
  metadataUri: string;
  metadataHash: Uint8Array | Buffer;
  programId?: PublicKey;
}

export function buildRegisterAgentIdentityInstruction(
  params: RegisterAgentIdentityParams,
): {
  instruction: TransactionInstruction;
  identityPda: PublicKey;
  bump: number;
} {
  const programId = params.programId ?? REGISTRY_PROGRAM_ID;
  const { pda: identityPda, bump } = deriveAgentIdentityPda(
    params.agentPubkey,
    programId,
  );

  const data = Buffer.concat([
    INSTRUCTION_DISCRIMINATOR.registerAgentIdentity,
    encodePubkey(params.agentPubkey),
    encodeString(params.name),
    encodeString(params.metadataUri),
    encodeMetadataHash(params.metadataHash),
  ]);

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: identityPda, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  return { instruction, identityPda, bump };
}

export interface UpdateAgentIdentityMetadataParams {
  identityPda: PublicKey;
  /** User wallet — must equal `identity.owner`. */
  owner: PublicKey;
  name: string;
  metadataUri: string;
  metadataHash: Uint8Array | Buffer;
  programId?: PublicKey;
}

export function buildUpdateAgentIdentityMetadataInstruction(
  params: UpdateAgentIdentityMetadataParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? REGISTRY_PROGRAM_ID;
  const data = Buffer.concat([
    INSTRUCTION_DISCRIMINATOR.updateAgentIdentityMetadata,
    encodeString(params.name),
    encodeString(params.metadataUri),
    encodeMetadataHash(params.metadataHash),
  ]);
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.identityPda, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
  return { instruction };
}

// ── Deployment ─────────────────────────────────────────────────────────────

export interface CreateDeploymentParams {
  companyPda: PublicKey;
  identityPda: PublicKey;
  /** User wallet — must equal both `company.owner` and `identity.owner`. */
  owner: PublicKey;
  payer: PublicKey;
  /** Per-company u32 counter. Caller picks the next free index. */
  deploymentIndex: number;
  /** Capability persona (e.g. "ceo", "sdr"). Bounded by MAX_ROLE_LEN. */
  role: string;
  /** Reporting parent index within this company (null = top-level). */
  parentDeploymentIndex?: number | null;
  /** Pinned adapter (`PublicKey.default` = unspecified). */
  adapterId: PublicKey;
  metadataUri: string;
  metadataHash: Uint8Array | Buffer;
  programId?: PublicKey;
}

export function buildCreateDeploymentInstruction(
  params: CreateDeploymentParams,
): {
  instruction: TransactionInstruction;
  deploymentPda: PublicKey;
  bump: number;
} {
  const programId = params.programId ?? REGISTRY_PROGRAM_ID;
  const { pda: deploymentPda, bump } = deriveDeploymentPda(
    params.companyPda,
    params.deploymentIndex,
    programId,
  );

  const data = Buffer.concat([
    INSTRUCTION_DISCRIMINATOR.createDeployment,
    u32LeBytes(params.deploymentIndex),
    encodeString(params.role),
    encodeOptionU32(params.parentDeploymentIndex),
    encodePubkey(params.adapterId),
    encodeString(params.metadataUri),
    encodeMetadataHash(params.metadataHash),
  ]);

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      // Order matches the on-chain `CreateDeployment` accounts struct.
      { pubkey: params.companyPda, isSigner: false, isWritable: false },
      { pubkey: params.identityPda, isSigner: false, isWritable: false },
      { pubkey: params.owner, isSigner: true, isWritable: false },
      { pubkey: deploymentPda, isSigner: false, isWritable: true },
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  return { instruction, deploymentPda, bump };
}

export interface UpdateDeploymentMetadataParams {
  deploymentPda: PublicKey;
  owner: PublicKey;
  role: string;
  metadataUri: string;
  metadataHash: Uint8Array | Buffer;
  programId?: PublicKey;
}

export function buildUpdateDeploymentMetadataInstruction(
  params: UpdateDeploymentMetadataParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? REGISTRY_PROGRAM_ID;
  const data = Buffer.concat([
    INSTRUCTION_DISCRIMINATOR.updateDeploymentMetadata,
    encodeString(params.role),
    encodeString(params.metadataUri),
    encodeMetadataHash(params.metadataHash),
  ]);
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.deploymentPda, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
  return { instruction };
}

export interface UpdateDeploymentStatusParams {
  deploymentPda: PublicKey;
  owner: PublicKey;
  /** 0 = Active, 1 = Paused. Use `retire_deployment` for terminal. */
  newStatus: number;
  programId?: PublicKey;
}

export function buildUpdateDeploymentStatusInstruction(
  params: UpdateDeploymentStatusParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? REGISTRY_PROGRAM_ID;
  const data = Buffer.concat([
    INSTRUCTION_DISCRIMINATOR.updateDeploymentStatus,
    encodeU8(params.newStatus),
  ]);
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.deploymentPda, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
  return { instruction };
}

export interface RetireDeploymentParams {
  deploymentPda: PublicKey;
  owner: PublicKey;
  programId?: PublicKey;
}

export function buildRetireDeploymentInstruction(
  params: RetireDeploymentParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? REGISTRY_PROGRAM_ID;
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.deploymentPda, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(INSTRUCTION_DISCRIMINATOR.retireDeployment),
  });
  return { instruction };
}

export interface SetOperatingWalletParams {
  deploymentPda: PublicKey;
  /** User wallet — must equal `deployment.owner`. */
  owner: PublicKey;
  /** New operating wallet. Pass `PublicKey.default` to clear. */
  newOperatingWallet: PublicKey;
  programId?: PublicKey;
}

export function buildSetOperatingWalletInstruction(
  params: SetOperatingWalletParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? REGISTRY_PROGRAM_ID;
  const data = Buffer.concat([
    INSTRUCTION_DISCRIMINATOR.setOperatingWallet,
    encodePubkey(params.newOperatingWallet),
  ]);
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.deploymentPda, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
  return { instruction };
}
