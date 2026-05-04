import { PublicKey } from "@solana/web3.js";

// Registry program ID. The vanity-grinded program keypair lives at
// `occa/programs/registry/registry-keypair.json` (gitignored). Public key
// is committed here so clients (server + web) can derive PDAs without
// loading the keypair.
//
// NOTE: this is the devnet program ID. Mainnet will likely have a
// different program ID — when that day comes, swap via env or config.
export const REGISTRY_PROGRAM_ID_BASE58 =
  "oCCAYWgH3KTWccrdHUkrGZQK8YAGTNVQp4V4Hxsv8LQ";

export const REGISTRY_PROGRAM_ID = new PublicKey(REGISTRY_PROGRAM_ID_BASE58);

// PDA seed prefixes. Must match `programs/registry/src/lib.rs` exactly.
export const COMPANY_SEED = Buffer.from("company");
export const AGENT_SEED = Buffer.from("agent");

// Custody models — DB column `agents.custody_model`.
export const CUSTODY_MODEL = {
  /** OCCA never holds privkey; FE derives via wallet.signMessage. MVP default. */
  SignToDerive: "sign_to_derive",
  /** Operator-managed signer. */
  Custodial: "custodial",
  /** k-of-n threshold. */
  Threshold: "threshold",
} as const;

export type CustodyModel = (typeof CUSTODY_MODEL)[keyof typeof CUSTODY_MODEL];

// Agent derivation message version — bumped if `buildAgentDerivationMessage`
// format changes. Persisted per-agent so re-derivation works for legacy rows.
export const CURRENT_DERIVATION_MSG_VERSION = 1;
