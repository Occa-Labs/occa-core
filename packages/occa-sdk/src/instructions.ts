import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  MAX_QUALITY_SCORE,
  MAX_RESULT_URI_LEN,
  OPERATIONS_KIND,
  REGISTRY_PROGRAM_ID,
  SOL_PSEUDO_MINT,
  TREASURY_PROGRAM_ID,
  type OperationsKind,
} from "./constants";
import {
  deriveAgentIdentityPda,
  deriveCompanyPda,
  deriveDailyAnchorPda,
  deriveDeploymentPda,
  deriveOperationsPda,
  derivePolicyPda,
  deriveProtocolFeePda,
  deriveTraceAnchorPda,
  deriveTreasuryPda,
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
  setReceivingAddress: Buffer.from([70, 63, 44, 87, 16, 6, 156, 200]),
  setAgentReceivingAddress: Buffer.from([197, 126, 122, 18, 38, 62, 179, 218]),
  commitDailyAnchor: Buffer.from([18, 7, 3, 65, 58, 148, 164, 0]),
  commitTrace: Buffer.from([58, 140, 230, 51, 170, 109, 228, 125]),
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
  treasuryPda: PublicKey;
  policyPda: PublicKey;
  bump: number;
} {
  const programId = params.programId ?? REGISTRY_PROGRAM_ID;
  const { pda: companyPda, bump } = deriveCompanyPda(
    params.owner,
    params.nonce,
    programId,
  );
  // Treasury + Policy PDAs initialized atomically inside the chain ix
  // via CPI to `treasury::init_treasury` (registry/lib.rs CreateCompany
  // accounts struct). Both must be passed in the tx even though they're
  // not yet allocated — chain CPI does the `init` against them.
  const { pda: treasuryPda } = deriveTreasuryPda(companyPda);
  const { pda: policyPda } = derivePolicyPda(companyPda);

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
    // Order MUST match registry/lib.rs `CreateCompany` accounts struct:
    // company, owner, payer, treasury, policy, treasury_program, system_program.
    keys: [
      { pubkey: companyPda, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: treasuryPda, isSigner: false, isWritable: true },
      { pubkey: policyPda, isSigner: false, isWritable: true },
      { pubkey: TREASURY_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  return { instruction, companyPda, treasuryPda, policyPda, bump };
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

export interface SetReceivingAddressParams {
  deploymentPda: PublicKey;
  /** User wallet — must equal `deployment.owner`. */
  owner: PublicKey;
  /** New receiving address (passive destination wallet for funds disbursed
   *  *to* this agent). Pass `PublicKey.default` to clear. NEVER a signer
   *  on chain — receiving address never authorizes any on-chain action. */
  newReceivingAddress: PublicKey;
  programId?: PublicKey;
}

export function buildSetReceivingAddressInstruction(
  params: SetReceivingAddressParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? REGISTRY_PROGRAM_ID;
  const data = Buffer.concat([
    INSTRUCTION_DISCRIMINATOR.setReceivingAddress,
    encodePubkey(params.newReceivingAddress),
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

export interface SetAgentReceivingAddressParams {
  /** AgentIdentity PDA whose personal receiving wallet is being set. */
  identityPda: PublicKey;
  /** User wallet — must equal `identity.owner`. */
  owner: PublicKey;
  /** New personal receiving address (passive destination for funds
   *  disbursed to this agent). Pass `PublicKey.default` to clear. NEVER a
   *  signer — it never authorizes any on-chain action. */
  newReceivingAddress: PublicKey;
  programId?: PublicKey;
}

// Sets the agent's PERSONAL receiving wallet on the AgentIdentity itself —
// independent of any company/deployment (Phase 4 marketplace). The deployment
// receiving_address defaults from this at create_deployment.
export function buildSetAgentReceivingAddressInstruction(
  params: SetAgentReceivingAddressParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? REGISTRY_PROGRAM_ID;
  const data = Buffer.concat([
    INSTRUCTION_DISCRIMINATOR.setAgentReceivingAddress,
    encodePubkey(params.newReceivingAddress),
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

// ── Treasury program ────────────────────────────────────────────────────────
//
// The treasury program is a SEPARATE program from registry — these
// instructions target `TREASURY_PROGRAM_ID`. Discriminators copied from
// `occa-programs/target/idl/treasury.json`.

export const TREASURY_INSTRUCTION_DISCRIMINATOR = {
  setPolicy: Buffer.from([40, 133, 12, 157, 235, 202, 2, 132]),
  disburseDiscretionary: Buffer.from([102, 176, 14, 127, 210, 4, 96, 175]),
  initProtocolFeeAccount: Buffer.from([214, 27, 184, 174, 155, 79, 141, 114]),
  registerCompanyOperations: Buffer.from([212, 173, 142, 23, 28, 221, 55, 99]),
  updateOperationsCapability: Buffer.from([21, 13, 197, 41, 92, 229, 142, 202]),
  revokeOperations: Buffer.from([141, 196, 241, 103, 182, 146, 117, 183]),
  closeOperations: Buffer.from([2, 52, 136, 225, 80, 230, 222, 120]),
  disburseRoutine: Buffer.from([45, 152, 225, 130, 133, 73, 62, 202]),
  disbursePrivileged: Buffer.from([173, 78, 248, 158, 76, 46, 88, 167]),
} as const;

// ── Borsh helpers for treasury args ─────────────────────────────────────────

function encodeU16(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
    throw new RangeError(`u16 out of range: ${n}`);
  }
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n, 0);
  return buf;
}

function encodeU64(n: bigint): Buffer {
  if (n < 0n || n > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`u64 out of range: ${n}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n, 0);
  return buf;
}

/** A per-asset budget / balance entry. `SOL_PSEUDO_MINT` for SOL. */
export interface AssetBudget {
  mint: PublicKey;
  amount: bigint;
}

function encodeAssetBudget(b: AssetBudget): Buffer {
  return Buffer.concat([encodePubkey(b.mint), encodeU64(b.amount)]);
}

/** Borsh `Vec<T>` = 4-byte LE length + each item. */
function encodeVec<T>(items: T[], encodeItem: (item: T) => Buffer): Buffer {
  return Buffer.concat([u32LeBytes(items.length), ...items.map(encodeItem)]);
}

/** Borsh `Option<T>` = 1-byte tag (0=None, 1=Some) + optional payload. */
function encodeOption<T>(
  value: T | null | undefined,
  encodeSome: (v: T) => Buffer,
): Buffer {
  if (value === null || value === undefined) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), encodeSome(value)]);
}

// ── set_policy ──────────────────────────────────────────────────────────────

export interface SetPolicyParams {
  companyPda: PublicKey;
  treasuryPda: PublicKey;
  policyPda: PublicKey;
  /** Must equal `company.owner` — the sole Privileged-class signer. */
  controllingAuthority: PublicKey;
  /** Per-month routine-class cap. Omit to leave unchanged. */
  routineBudgetPerMonth?: AssetBudget[];
  /** Per-month discretionary-class cap. Omit to leave unchanged. */
  discretionaryBudgetPerMonth?: AssetBudget[];
  /** SOL threshold above which Privileged-class disbursement (= owner +
   *  secondary signer) is required. Omit to leave unchanged. Pass
   *  `u64::MAX` (-1n cast) to disable (= secondary signer never required). */
  privilegedThresholdLamports?: bigint;
  /** Per-asset threshold variant of the above. Omit to leave unchanged. */
  privilegedThresholdPerToken?: AssetBudget[];
  /** Second signer required for Privileged-class disbursements.
   *  Distinguishes three cases:
   *   • `undefined` — leave unchanged
   *   • `null`      — clear (no secondary signer; Privileged disburse
   *                   then has no valid signer combination, effectively
   *                   disabling it)
   *   • `PublicKey` — set to this pubkey */
  secondarySigner?: PublicKey | null;
  /** Agent Operating Fee in basis points. Omit to leave unchanged. */
  agentOperatingFeeBps?: number;
  /** Accepted-asset allow-list. Omit to leave unchanged. */
  acceptedAssets?: PublicKey[];
  programId?: PublicKey;
}

/**
 * Build a `set_policy` instruction. Privileged-class — signed by the
 * controlling authority (= company owner).
 *
 * Every parameter is `Option<T>`: omitted = "leave unchanged". For
 * `secondarySigner`, JS `null` maps to the "clear" case (outer Some,
 * inner None) — see the field doc above.
 */
export function buildSetPolicyInstruction(params: SetPolicyParams): {
  instruction: TransactionInstruction;
} {
  const programId = params.programId ?? TREASURY_PROGRAM_ID;

  // Borsh `Option<Option<Pubkey>>` encoder for secondary_signer:
  //   undefined → outer None  (00)
  //   null      → outer Some, inner None  (01 00)
  //   pubkey    → outer Some, inner Some  (01 01 <32 bytes>)
  function encodeSecondarySigner(v: PublicKey | null | undefined): Buffer {
    if (v === undefined) return Buffer.from([0]);
    if (v === null) return Buffer.from([1, 0]);
    return Buffer.concat([Buffer.from([1, 1]), encodePubkey(v)]);
  }

  // Field order MUST match the on-chain `SetPolicyParams` struct.
  const data = Buffer.concat([
    TREASURY_INSTRUCTION_DISCRIMINATOR.setPolicy,
    // 1. routine_budget_per_month: Option<Vec<AssetBudget>>
    encodeOption(params.routineBudgetPerMonth, (v) =>
      encodeVec(v, encodeAssetBudget),
    ),
    // 2. discretionary_budget_per_month: Option<Vec<AssetBudget>>
    encodeOption(params.discretionaryBudgetPerMonth, (v) =>
      encodeVec(v, encodeAssetBudget),
    ),
    // 3. privileged_threshold_lamports: Option<u64>
    encodeOption(params.privilegedThresholdLamports, encodeU64),
    // 4. privileged_threshold_per_token: Option<Vec<AssetBudget>>
    encodeOption(params.privilegedThresholdPerToken, (v) =>
      encodeVec(v, encodeAssetBudget),
    ),
    // 5. secondary_signer: Option<Option<Pubkey>>
    encodeSecondarySigner(params.secondarySigner),
    // 6. agent_operating_fee_bps: Option<u16>
    encodeOption(params.agentOperatingFeeBps, encodeU16),
    // 7. accepted_assets: Option<Vec<Pubkey>>
    encodeOption(params.acceptedAssets, (v) => encodeVec(v, encodePubkey)),
  ]);

  const instruction = new TransactionInstruction({
    programId,
    // Order: company, controlling_authority, treasury, policy.
    keys: [
      { pubkey: params.companyPda, isSigner: false, isWritable: false },
      {
        pubkey: params.controllingAuthority,
        isSigner: true,
        isWritable: false,
      },
      { pubkey: params.treasuryPda, isSigner: false, isWritable: true },
      { pubkey: params.policyPda, isSigner: false, isWritable: true },
    ],
    data,
  });
  return { instruction };
}

// ── disburse_discretionary ──────────────────────────────────────────────────

export interface DisburseDiscretionaryParams {
  companyPda: PublicKey;
  treasuryPda: PublicKey;
  policyPda: PublicKey;
  /** Must equal `company.owner`. */
  controllingAuthority: PublicKey;
  /** Deployment PDA of the agent being paid — chain matches `destination`
   *  against its `receiving_address`. */
  deploymentPda: PublicKey;
  /** The agent's receiving address — destination of the funds. */
  destination: PublicKey;
  /** Amount in lamports (SOL only — Phase 1). */
  amountLamports: bigint;
  /** Defaults to `SOL_PSEUDO_MINT`. */
  mint?: PublicKey;
  programId?: PublicKey;
}

/**
 * Build a `disburse_discretionary` instruction — Discretionary-class
 * payout to an agent's receiving address, signed by the controlling
 * authority. The 3% Agent Operating Fee is deducted on-chain and routed
 * to the ProtocolFeeAccount.
 */
export function buildDisburseDiscretionaryInstruction(
  params: DisburseDiscretionaryParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? TREASURY_PROGRAM_ID;
  const mint = params.mint ?? SOL_PSEUDO_MINT;
  const { pda: protocolFeePda } = deriveProtocolFeePda();

  const data = Buffer.concat([
    TREASURY_INSTRUCTION_DISCRIMINATOR.disburseDiscretionary,
    encodePubkey(mint),
    encodeU64(params.amountLamports),
  ]);

  const instruction = new TransactionInstruction({
    programId,
    // Order: company, controlling_authority, treasury, policy,
    // deployment, destination, protocol_fee_account.
    keys: [
      { pubkey: params.companyPda, isSigner: false, isWritable: false },
      {
        pubkey: params.controllingAuthority,
        isSigner: true,
        isWritable: false,
      },
      { pubkey: params.treasuryPda, isSigner: false, isWritable: true },
      { pubkey: params.policyPda, isSigner: false, isWritable: true },
      { pubkey: params.deploymentPda, isSigner: false, isWritable: false },
      { pubkey: params.destination, isSigner: false, isWritable: true },
      { pubkey: protocolFeePda, isSigner: false, isWritable: true },
    ],
    data,
  });
  return { instruction };
}

// ── Treasury: more builders ────────────────────────────────────────────────

/** Encode an i64 as little-endian 8 bytes (Borsh). */
function encodeI64(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(n, 0);
  return buf;
}

/** Encode a Borsh bool — single byte 0 or 1. */
function encodeBool(b: boolean): Buffer {
  return Buffer.from([b ? 1 : 0]);
}

/** Encode an 8-byte action whitelist entry (Anchor ix discriminator). */
function encodeAction(disc: Uint8Array | Buffer): Buffer {
  if (disc.length !== 8) {
    throw new RangeError(`action_whitelist entry must be 8 bytes, got ${disc.length}`);
  }
  return Buffer.from(disc);
}

// ── init_protocol_fee_account ───────────────────────────────────────────────

export interface InitProtocolFeeAccountParams {
  /** Upgrade authority of the Treasury program. Pays + signs. */
  authority: PublicKey;
  /** Long-lived withdrawal authority for accumulated fees (e.g. governance
   *  multisig). Immutable after init. */
  governance: PublicKey;
  /** The Treasury program's own pubkey — passed as an account. Defaults to
   *  `TREASURY_PROGRAM_ID`. */
  program?: PublicKey;
  /** The program's ProgramData PDA (BPFLoaderUpgradeable). Anchor uses this
   *  to verify the signer is the upgrade authority. Caller derives:
   *    `PublicKey.findProgramAddressSync([program.toBuffer()],
   *     BPF_LOADER_UPGRADEABLE_PROGRAM_ID)`. */
  programData: PublicKey;
  programId?: PublicKey;
}

/**
 * Build an `init_protocol_fee_account` instruction. Singleton — call once
 * per program deployment by the upgrade authority. Subsequent calls fail
 * (PDA already initialized).
 */
export function buildInitProtocolFeeAccountInstruction(
  params: InitProtocolFeeAccountParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? TREASURY_PROGRAM_ID;
  const programAccount = params.program ?? programId;
  const { pda: protocolFeePda } = deriveProtocolFeePda(programId);

  const data = Buffer.concat([
    TREASURY_INSTRUCTION_DISCRIMINATOR.initProtocolFeeAccount,
    encodePubkey(params.governance),
  ]);

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: protocolFeePda, isSigner: false, isWritable: true },
      { pubkey: params.authority, isSigner: true, isWritable: true },
      { pubkey: programAccount, isSigner: false, isWritable: false },
      { pubkey: params.programData, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  return { instruction };
}

// ── register_company_operations ─────────────────────────────────────────────

export interface RegisterCompanyOperationsParams {
  companyPda: PublicKey;
  /** Must equal `company.owner` — Privileged-class signer. */
  controllingAuthority: PublicKey;
  /** Disbursement or Anchor — determines which OperationsAccount PDA is
   *  created. Order matters: enum byte is part of the seed. */
  kind: OperationsKind;
  /** Hot wallet that will sign downstream operations ix (e.g.
   *  `disburse_routine` for Disbursement, `commit_daily_anchor` for Anchor). */
  signer: PublicKey;
  /** Each entry = an 8-byte Anchor instruction discriminator the signer
   *  is allowed to invoke. Empty = no actions permitted (account exists
   *  but is essentially disabled). */
  actionWhitelist: (Uint8Array | Buffer)[];
  /** How many disburse calls this signer may make per calendar month. */
  rateLimitPerPeriod: number;
  /** Unix seconds. `0` = never expires. */
  expiryUnix: bigint;
  /** Rent payer — typically the operator hot wallet. */
  payer: PublicKey;
  programId?: PublicKey;
}

/**
 * Build a `register_company_operations` instruction — creates an
 * OperationsAccount binding a hot wallet to a capability set. Privileged-
 * class (signed by `controlling_authority` = company owner).
 */
export function buildRegisterCompanyOperationsInstruction(
  params: RegisterCompanyOperationsParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? TREASURY_PROGRAM_ID;
  const { pda: operationsPda } = deriveOperationsPda(
    params.companyPda,
    params.kind,
    programId,
  );

  const data = Buffer.concat([
    TREASURY_INSTRUCTION_DISCRIMINATOR.registerCompanyOperations,
    // kind: u8 enum byte
    Buffer.from([params.kind]),
    encodePubkey(params.signer),
    encodeVec(params.actionWhitelist, encodeAction),
    u32LeBytes(params.rateLimitPerPeriod),
    encodeI64(params.expiryUnix),
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
      { pubkey: operationsPda, isSigner: false, isWritable: true },
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  return { instruction };
}

// ── update_operations_capability ────────────────────────────────────────────

export interface UpdateOperationsCapabilityParams {
  companyPda: PublicKey;
  controllingAuthority: PublicKey;
  /** Which OperationsAccount (by kind) to update. */
  kind: OperationsKind;
  /** Each field is independently optional — omitted = "leave unchanged". */
  actionWhitelist?: (Uint8Array | Buffer)[];
  rateLimitPerPeriod?: number;
  /** Pass `0n` to set "no expiry" sentinel; `undefined` to leave unchanged. */
  expiryUnix?: bigint;
  programId?: PublicKey;
}

/**
 * Build an `update_operations_capability` instruction — Privileged-class
 * mutation of an existing OperationsAccount's whitelist / rate limit /
 * expiry. Each param is Option-encoded.
 */
export function buildUpdateOperationsCapabilityInstruction(
  params: UpdateOperationsCapabilityParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? TREASURY_PROGRAM_ID;
  const { pda: operationsPda } = deriveOperationsPda(
    params.companyPda,
    params.kind,
    programId,
  );

  // Field order MUST match `UpdateOperationsCapabilityParams` struct.
  const argBody = Buffer.concat([
    encodeOption(params.actionWhitelist, (v) => encodeVec(v, encodeAction)),
    encodeOption(params.rateLimitPerPeriod, u32LeBytes),
    encodeOption(params.expiryUnix, encodeI64),
  ]);

  const data = Buffer.concat([
    TREASURY_INSTRUCTION_DISCRIMINATOR.updateOperationsCapability,
    argBody,
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
      { pubkey: operationsPda, isSigner: false, isWritable: true },
    ],
    data,
  });
  return { instruction };
}

// ── revoke_operations ───────────────────────────────────────────────────────

export interface RevokeOperationsParams {
  companyPda: PublicKey;
  controllingAuthority: PublicKey;
  kind: OperationsKind;
  programId?: PublicKey;
}

/**
 * Build a `revoke_operations` instruction — flips the `revoked` flag on
 * the OperationsAccount. Subsequent ix attempts by the signer fail. The
 * account stays open (rent retained); call `close_operations` to reclaim.
 */
export function buildRevokeOperationsInstruction(
  params: RevokeOperationsParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? TREASURY_PROGRAM_ID;
  const { pda: operationsPda } = deriveOperationsPda(
    params.companyPda,
    params.kind,
    programId,
  );

  const data = Buffer.from(TREASURY_INSTRUCTION_DISCRIMINATOR.revokeOperations);

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.companyPda, isSigner: false, isWritable: false },
      {
        pubkey: params.controllingAuthority,
        isSigner: true,
        isWritable: false,
      },
      { pubkey: operationsPda, isSigner: false, isWritable: true },
    ],
    data,
  });
  return { instruction };
}

// ── close_operations ────────────────────────────────────────────────────────

export interface CloseOperationsParams {
  companyPda: PublicKey;
  /** Rent refund destination + signer. */
  controllingAuthority: PublicKey;
  kind: OperationsKind;
  programId?: PublicKey;
}

/**
 * Build a `close_operations` instruction — closes the OperationsAccount
 * and refunds rent to `controlling_authority`. Permanent: a new
 * register call would create a fresh account at the same PDA.
 */
export function buildCloseOperationsInstruction(
  params: CloseOperationsParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? TREASURY_PROGRAM_ID;
  const { pda: operationsPda } = deriveOperationsPda(
    params.companyPda,
    params.kind,
    programId,
  );

  const data = Buffer.from(TREASURY_INSTRUCTION_DISCRIMINATOR.closeOperations);

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.companyPda, isSigner: false, isWritable: false },
      {
        pubkey: params.controllingAuthority,
        isSigner: true,
        isWritable: true,
      },
      { pubkey: operationsPda, isSigner: false, isWritable: true },
    ],
    data,
  });
  return { instruction };
}

// ── disburse_routine ────────────────────────────────────────────────────────

export interface DisburseRoutineParams {
  companyPda: PublicKey;
  treasuryPda: PublicKey;
  policyPda: PublicKey;
  /** Disbursement-kind OperationsAccount for this company. */
  operationsPda: PublicKey;
  /** Hot wallet matching `operations.signer` — the only signer. NOT the
   *  controlling authority. */
  operationsSigner: PublicKey;
  /** Deployment PDA of the agent being paid. */
  deploymentPda: PublicKey;
  /** Agent's receiving_address. Chain verifies match against deployment. */
  destination: PublicKey;
  amountLamports: bigint;
  /** Defaults to `SOL_PSEUDO_MINT`. */
  mint?: PublicKey;
  programId?: PublicKey;
}

/**
 * Build a `disburse_routine` instruction — Routine-class batched payout.
 * Signed by the Disbursement Wallet (operations_signer), NOT the company
 * owner. Whitelist + rate limit + expiry enforced on-chain by the
 * OperationsAccount. The 3% Agent Operating Fee is deducted and routed
 * to ProtocolFeeAccount.
 */
export function buildDisburseRoutineInstruction(
  params: DisburseRoutineParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? TREASURY_PROGRAM_ID;
  const mint = params.mint ?? SOL_PSEUDO_MINT;
  const { pda: protocolFeePda } = deriveProtocolFeePda(programId);

  const data = Buffer.concat([
    TREASURY_INSTRUCTION_DISCRIMINATOR.disburseRoutine,
    encodePubkey(mint),
    encodeU64(params.amountLamports),
  ]);

  const instruction = new TransactionInstruction({
    programId,
    // Order: company, treasury, policy, operations, operations_signer,
    // deployment, destination, protocol_fee_account.
    keys: [
      { pubkey: params.companyPda, isSigner: false, isWritable: false },
      { pubkey: params.treasuryPda, isSigner: false, isWritable: true },
      { pubkey: params.policyPda, isSigner: false, isWritable: true },
      { pubkey: params.operationsPda, isSigner: false, isWritable: true },
      { pubkey: params.operationsSigner, isSigner: true, isWritable: false },
      { pubkey: params.deploymentPda, isSigner: false, isWritable: false },
      { pubkey: params.destination, isSigner: false, isWritable: true },
      { pubkey: protocolFeePda, isSigner: false, isWritable: true },
    ],
    data,
  });
  return { instruction };
}

// ── disburse_privileged ─────────────────────────────────────────────────────

export interface DisbursePrivilegedParams {
  companyPda: PublicKey;
  treasuryPda: PublicKey;
  policyPda: PublicKey;
  /** Must equal `company.owner`. */
  controllingAuthority: PublicKey;
  /** Must equal `policy.secondary_signer` (which must be set, i.e. not
   *  the default pubkey, for Privileged disbursements to work). */
  secondarySigner: PublicKey;
  /** Deployment of the recipient agent when `isAgentDestination = true`.
   *  Still required as a read-only account even for external destinations
   *  (chain verifies it belongs to the same company). */
  deploymentPda: PublicKey;
  destination: PublicKey;
  amountLamports: bigint;
  /** Whether the destination is an in-company agent (fee applies) or an
   *  external party (no fee). */
  isAgentDestination: boolean;
  mint?: PublicKey;
  programId?: PublicKey;
}

/**
 * Build a `disburse_privileged` instruction — over-threshold or
 * externally-destined payout. Requires both the controlling authority
 * (owner) AND a secondary signer. Bypasses normal budget caps; logged
 * in the policy's privileged-spent counter regardless.
 */
export function buildDisbursePrivilegedInstruction(
  params: DisbursePrivilegedParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? TREASURY_PROGRAM_ID;
  const mint = params.mint ?? SOL_PSEUDO_MINT;
  const { pda: protocolFeePda } = deriveProtocolFeePda(programId);

  const data = Buffer.concat([
    TREASURY_INSTRUCTION_DISCRIMINATOR.disbursePrivileged,
    encodePubkey(mint),
    encodeU64(params.amountLamports),
    encodeBool(params.isAgentDestination),
  ]);

  const instruction = new TransactionInstruction({
    programId,
    // Order: company, controlling_authority, secondary_signer, treasury,
    // policy, deployment, destination, protocol_fee_account.
    keys: [
      { pubkey: params.companyPda, isSigner: false, isWritable: false },
      {
        pubkey: params.controllingAuthority,
        isSigner: true,
        isWritable: false,
      },
      { pubkey: params.secondarySigner, isSigner: true, isWritable: false },
      { pubkey: params.treasuryPda, isSigner: false, isWritable: true },
      { pubkey: params.policyPda, isSigner: false, isWritable: false },
      { pubkey: params.deploymentPda, isSigner: false, isWritable: false },
      { pubkey: params.destination, isSigner: false, isWritable: true },
      { pubkey: protocolFeePda, isSigner: false, isWritable: true },
    ],
    data,
  });
  return { instruction };
}

// ── Registry: commit_daily_anchor ───────────────────────────────────────────

export interface CommitDailyAnchorParams {
  deploymentPda: PublicKey;
  companyPda: PublicKey;
  /** Anchor Wallet — must equal `operations.signer` (kind=Anchor). */
  anchorSigner: PublicKey;
  /** Anchor-kind OperationsAccount for this company (in TREASURY program,
   *  read-only here). Caller derives via `deriveOperationsPda(company,
   *  OPERATIONS_KIND.Anchor)`. */
  operationsPda: PublicKey;
  /** Unix seconds aligned to 00:00:00 UTC for the day this anchor covers
   *  (multiple of 86_400). Becomes part of the DailyAnchor PDA seed. */
  dayUnix: bigint;
  /** Merkle root over the day's task hashes — 32 bytes. */
  merkleRoot: Uint8Array | Buffer;
  /** Number of leaves in the Merkle tree. Must be > 0. */
  taskCount: number;
  /** Rent payer (typically the operator hot wallet). */
  payer: PublicKey;
  programId?: PublicKey;
}

/**
 * Build a `commit_daily_anchor` instruction — Anchor-class single-tx
 * commit of one agent-day's Merkle-rooted task activity. Signed by the
 * Anchor Wallet bound to the company's Anchor-kind OperationsAccount.
 *
 * Caller is responsible for:
 *   1. Hashing each task's content (Blake3) off-chain
 *   2. Building the Merkle tree
 *   3. Passing the root + leaf count here
 *
 * The on-chain handler does NOT verify the Merkle tree itself — chain
 * holds only the commitment; verification happens off-chain against the
 * trace store.
 */
export function buildCommitDailyAnchorInstruction(
  params: CommitDailyAnchorParams,
): { instruction: TransactionInstruction } {
  const programId = params.programId ?? REGISTRY_PROGRAM_ID;
  if (params.merkleRoot.length !== 32) {
    throw new RangeError(
      `merkleRoot must be 32 bytes, got ${params.merkleRoot.length}`,
    );
  }
  const { pda: dailyAnchorPda } = deriveDailyAnchorPda(
    params.deploymentPda,
    params.dayUnix,
    programId,
  );

  const data = Buffer.concat([
    INSTRUCTION_DISCRIMINATOR.commitDailyAnchor,
    encodeI64(params.dayUnix),
    Buffer.from(params.merkleRoot),
    u32LeBytes(params.taskCount),
  ]);

  const instruction = new TransactionInstruction({
    programId,
    // Order: deployment, company, anchor_signer, operations, daily_anchor,
    // payer, system_program.
    keys: [
      { pubkey: params.deploymentPda, isSigner: false, isWritable: false },
      { pubkey: params.companyPda, isSigner: false, isWritable: false },
      { pubkey: params.anchorSigner, isSigner: true, isWritable: false },
      { pubkey: params.operationsPda, isSigner: false, isWritable: false },
      { pubkey: dailyAnchorPda, isSigner: false, isWritable: true },
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  return { instruction };
}

export interface CommitTraceParams {
  deploymentPda: PublicKey;
  companyPda: PublicKey;
  /** Anchor Wallet — must equal `operations.signer` (kind=Anchor). */
  anchorSigner: PublicKey;
  /** Anchor-kind OperationsAccount for this company (in TREASURY program,
   *  read-only here). Caller derives via `deriveOperationsPda(company,
   *  OPERATIONS_KIND.Anchor)`. */
  operationsPda: PublicKey;
  /** 32-byte hash of the task creation params — globally unique, becomes
   *  part of the TraceAnchor PDA seed. */
  taskId: Uint8Array | Buffer;
  /** Link to the deliverable (article URL, PR, etc). Max
   *  `MAX_RESULT_URI_LEN` bytes. */
  resultUri: string;
  /** SHA-256 of the deliverable content at completion (32 bytes). */
  contentHash: Uint8Array | Buffer;
  /** Rubric quality score, 0..=`MAX_QUALITY_SCORE`. */
  qualityScore: number;
  /** Version of the scoring rubric that produced `qualityScore`. */
  rubricVersion: number;
  /** SHA-256 of the off-chain verification report (32 bytes). */
  evidenceHash: Uint8Array | Buffer;
  /** Unix seconds the deliverable was completed off-chain. Must be > 0 and
   *  not in the future. */
  completedAt: bigint;
  /** Rent payer (typically the operator hot wallet). */
  payer: PublicKey;
  programId?: PublicKey;
}

/**
 * Build a `commit_trace` instruction — Anchor-class single-tx commit of one
 * completed, VERIFIED deliverable. Signed by the Anchor Wallet bound to the
 * company's Anchor-kind OperationsAccount (same authority as
 * `commit_daily_anchor`).
 *
 * Only deliverables that passed the off-chain verification gate should be
 * committed — the on-chain `verdict` is always Passed. Caller is
 * responsible for:
 *   1. Computing `contentHash` (SHA-256 of the deliverable)
 *   2. Running the verification gate + scoring rubric off-chain
 *   3. Computing `evidenceHash` (SHA-256 of the verification report)
 *
 * The verdict byte is fixed on-chain; it is not a caller arg.
 */
export function buildCommitTraceInstruction(params: CommitTraceParams): {
  instruction: TransactionInstruction;
  traceAnchorPda: PublicKey;
} {
  const programId = params.programId ?? REGISTRY_PROGRAM_ID;
  if (params.taskId.length !== 32) {
    throw new RangeError(`taskId must be 32 bytes, got ${params.taskId.length}`);
  }
  if (params.contentHash.length !== 32) {
    throw new RangeError(
      `contentHash must be 32 bytes, got ${params.contentHash.length}`,
    );
  }
  if (params.evidenceHash.length !== 32) {
    throw new RangeError(
      `evidenceHash must be 32 bytes, got ${params.evidenceHash.length}`,
    );
  }
  if (Buffer.from(params.resultUri, "utf8").length > MAX_RESULT_URI_LEN) {
    throw new RangeError(
      `resultUri exceeds MAX_RESULT_URI_LEN (${MAX_RESULT_URI_LEN} bytes)`,
    );
  }
  if (params.qualityScore < 0 || params.qualityScore > MAX_QUALITY_SCORE) {
    throw new RangeError(
      `qualityScore out of range 0..=${MAX_QUALITY_SCORE}: ${params.qualityScore}`,
    );
  }

  const taskId = Buffer.from(params.taskId);
  const { pda: traceAnchorPda } = deriveTraceAnchorPda(taskId, programId);

  // Wire arg order must match the Rust handler: task_id, result_uri,
  // content_hash, quality_score, rubric_version, evidence_hash,
  // completed_at. verdict is NOT a wire arg (fixed Passed on-chain).
  const data = Buffer.concat([
    INSTRUCTION_DISCRIMINATOR.commitTrace,
    taskId,
    encodeString(params.resultUri),
    Buffer.from(params.contentHash),
    encodeU8(params.qualityScore),
    encodeU8(params.rubricVersion),
    Buffer.from(params.evidenceHash),
    encodeI64(params.completedAt),
  ]);

  const instruction = new TransactionInstruction({
    programId,
    // Order: deployment, company, anchor_signer, operations, trace_anchor,
    // payer, system_program.
    keys: [
      { pubkey: params.deploymentPda, isSigner: false, isWritable: false },
      { pubkey: params.companyPda, isSigner: false, isWritable: false },
      { pubkey: params.anchorSigner, isSigner: true, isWritable: false },
      { pubkey: params.operationsPda, isSigner: false, isWritable: false },
      { pubkey: traceAnchorPda, isSigner: false, isWritable: true },
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  return { instruction, traceAnchorPda };
}
