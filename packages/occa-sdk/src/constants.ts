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

// PDA seed prefixes. Must match `occa-programs/programs/registry/src/lib.rs` exactly.
export const COMPANY_SEED = Buffer.from("company");
export const AGENT_IDENTITY_SEED = Buffer.from("agent_identity");
export const DEPLOYMENT_SEED = Buffer.from("deployment");

// On-chain bounds — must match `occa-programs/programs/registry/src/lib.rs`.
export const MAX_NAME_LEN = 64;
export const MAX_LOCALE_LEN = 8;
export const MAX_ROLE_LEN = 32;
export const MAX_METADATA_URI_LEN = 200;
export const MAX_REPUTATION_URI_LEN = 200;

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
} as const;
