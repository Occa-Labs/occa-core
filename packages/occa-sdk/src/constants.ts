import { PublicKey } from "@solana/web3.js";

// Registry program ID. The vanity-grinded program keypair lives at
// `occa-programs/programs/registry/registry-keypair.json` (gitignored,
// sibling repo). Public key is committed here so clients (server +
// web) can derive PDAs without loading the keypair.
//
// NOTE: this is the devnet program ID. Mainnet will likely have a
// different program ID — when that day comes, swap via env or config.
export const REGISTRY_PROGRAM_ID_BASE58 =
  "occaTHMv5eYG5aZ85jimxTvHkBfsDCvndXC6J2k8kxr";

export const REGISTRY_PROGRAM_ID = new PublicKey(REGISTRY_PROGRAM_ID_BASE58);

// Treasury program ID — devnet. Registry's `create_company` CPIs into
// `treasury::init_treasury` to atomically initialize the company's
// TreasuryAccount + PolicyAccount PDAs (per design doc §6).
export const TREASURY_PROGRAM_ID_BASE58 =
  "occaxyVLnurdjedWCBPrvDCCto8wGYadtTZ3nAmcVzh";

export const TREASURY_PROGRAM_ID = new PublicKey(TREASURY_PROGRAM_ID_BASE58);

// PDA seed prefixes. Must match `occa-programs/programs/registry/src/lib.rs` exactly.
export const COMPANY_SEED = Buffer.from("company");
export const AGENT_IDENTITY_SEED = Buffer.from("agent_identity");
export const DEPLOYMENT_SEED = Buffer.from("deployment");
// Treasury PDA seeds (owned by treasury program). Must match
// `occa-programs/programs/treasury/src/lib.rs`.
export const TREASURY_SEED = Buffer.from("treasury");
export const POLICY_SEED = Buffer.from("policy");
export const PROTOCOL_FEES_SEED = Buffer.from("protocol_fees");
export const OPERATIONS_SEED = Buffer.from("operations");
// DailyAnchor PDA seed (owned by registry program). Seeds:
// ["daily_anchor", deployment_pda, day_unix_le_i64_8bytes].
export const DAILY_ANCHOR_SEED = Buffer.from("daily_anchor");
// TraceAnchor PDA seed (owned by registry program). Seeds:
// ["trace", task_id_32bytes]. One per completed, verified deliverable.
export const TRACE_SEED = Buffer.from("trace");

// OperationsKind discriminator byte — must match the Rust enum order in
// `treasury/src/lib.rs`. Used as the 3rd seed byte of an OperationsAccount
// PDA and as a u8 wire arg to `register_company_operations`.
export const OPERATIONS_KIND = {
  /** Disbursement Wallet — operator-held only, signs `disburse_routine`. */
  Disbursement: 0,
  /**
   * Anchor Wallet — operator+OCCA shared, signs `commit_daily_anchor`
   * and `commit_trace`.
   */
  Anchor: 1,
} as const;
export type OperationsKind =
  (typeof OPERATIONS_KIND)[keyof typeof OPERATIONS_KIND];

// SOL has no real SPL mint — lamports live directly on accounts. The
// treasury program uses the default (all-zero) pubkey as the SOL marker
// in accepted-asset lists and disbursement mint args.
export const SOL_PSEUDO_MINT = new PublicKey(new Uint8Array(32));

// On-chain bounds — must match `occa-programs/programs/registry/src/lib.rs`.
export const MAX_NAME_LEN = 64;
export const MAX_LOCALE_LEN = 8;
export const MAX_ROLE_LEN = 32;
export const MAX_METADATA_URI_LEN = 200;
export const MAX_REPUTATION_URI_LEN = 200;
export const MAX_RESULT_URI_LEN = 200;
export const MAX_QUALITY_SCORE = 100;

// TraceAnchorAccount.verdict encoding — only Passed deliverables are
// anchored (failed/unverified work never reaches the chain).
export const TRACE_VERDICT = {
  Passed: 1,
} as const;
export type TraceVerdict = (typeof TRACE_VERDICT)[keyof typeof TRACE_VERDICT];

// Status encodings — must match the on-chain constants.
export const COMPANY_STATUS = {
  Active: 0,
  Paused: 1,
} as const;
export type CompanyStatus =
  (typeof COMPANY_STATUS)[keyof typeof COMPANY_STATUS];

export const DEPLOYMENT_STATUS = {
  Active: 0,
  Paused: 1,
  /** Terminal — retired deployments cannot be reactivated. */
  Retired: 2,
} as const;
export type DeploymentStatus =
  (typeof DEPLOYMENT_STATUS)[keyof typeof DEPLOYMENT_STATUS];

// Account discriminators (Anchor sha256("account:<Name>")[..8]).
export const ACCOUNT_DISCRIMINATOR = {
  AgentIdentity: Buffer.from([11, 149, 31, 27, 186, 76, 241, 72]),
  CompanyAccount: Buffer.from([37, 215, 171, 200, 8, 141, 69, 96]),
  Deployment: Buffer.from([66, 90, 104, 89, 183, 130, 64, 178]),
  DailyAnchorAccount: Buffer.from([218, 106, 107, 94, 194, 48, 111, 254]),
  TraceAnchorAccount: Buffer.from([159, 101, 186, 98, 211, 217, 119, 232]),
} as const;

// Treasury program account discriminators — from
// `occa-programs/target/idl/treasury.json`.
export const TREASURY_ACCOUNT_DISCRIMINATOR = {
  TreasuryAccount: Buffer.from([204, 140, 18, 173, 90, 152, 134, 123]),
  PolicyAccount: Buffer.from([218, 201, 183, 164, 156, 127, 81, 175]),
  ProtocolFeeAccount: Buffer.from([5, 171, 24, 9, 150, 135, 135, 201]),
  OperationsAccount: Buffer.from([185, 55, 148, 90, 151, 227, 104, 158]),
} as const;
