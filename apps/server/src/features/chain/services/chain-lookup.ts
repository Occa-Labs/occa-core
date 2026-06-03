import { PublicKey } from "@solana/web3.js";
import {
  ACCOUNT_DISCRIMINATOR,
  DEPLOYMENT_STATUS,
  REGISTRY_PROGRAM_ID,
  deriveCompanyPda,
  deriveDeploymentPda,
  type DeploymentStatus,
} from "@occa/sdk";
import { getConnection } from "../../../infra/solana/connection";
import { childLogger } from "../../../lib/logger";

const log = childLogger("chain:lookup");

// Borsh-style cursor — registry accounts have variable-length string fields
// (name, metadata_uri, role) so fixed offsets only work up to the first
// string. Past that we sequence-read.
class BorshCursor {
  constructor(
    private readonly data: Buffer,
    private offset: number,
  ) {}
  get pos(): number {
    return this.offset;
  }
  remaining(): number {
    return this.data.length - this.offset;
  }
  skip(n: number): void {
    this.offset += n;
  }
  readU8(): number {
    const v = this.data.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }
  readU32(): number {
    const v = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  readI64(): bigint {
    const v = this.data.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  readPubkey(): PublicKey {
    const v = new PublicKey(this.data.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v;
  }
  readBytes32(): Buffer {
    const v = Buffer.from(this.data.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v;
  }
  readString(): string {
    const len = this.readU32();
    const v = this.data
      .subarray(this.offset, this.offset + len)
      .toString("utf8");
    this.offset += len;
    return v;
  }
  readOptionU32(): number | null {
    const tag = this.readU8();
    if (tag === 0) return null;
    return this.readU32();
  }
}

function checkDiscriminator(data: Buffer, expected: Buffer): boolean {
  if (data.length < 8) return false;
  return data.subarray(0, 8).equals(expected);
}

// Borsh layout offsets for the registry program's CompanyAccount. Fixed
// up to the trailing variable-length `metadata_uri` string, so byte-slice
// decoding is safe and avoids pulling Anchor's runtime just to decode.
//
// CompanyAccount (raw bytes including 8-byte discriminator)
//   0   discriminator (8)
//   8   version (1)
//   9   owner pubkey (32)
//   41  treasury pubkey (32)
//   73  policy pubkey (32)
//   105 created_at i64 LE (8)
//   113 nonce u32 LE (4)
//   117 metadata_uri (string: 4-byte u32 LE length + UTF-8 bytes)
const COMPANY_OFFSET_OWNER = 9;
const COMPANY_OFFSET_NONCE = 113;
const COMPANY_MIN_LEN = 117 + 4;

export interface OnChainCompany {
  companyPda: PublicKey;
  owner: PublicKey;
  nonce: number;
}

/**
 * Enumerate every CompanyAccount derived from `(userWallet, nonce=0..MAX)`.
 * Returns existing PDAs in nonce order with their decoded fields.
 *
 * Cheap: deterministic PDA derivation on the client + a single
 * `getMultipleAccountsInfo` RPC call. No global index, no `memcmp` scan.
 *
 * Recovery semantics: after a DB / dev reset the wallet's on-chain
 * companies survive. Use the returned `nonce` set both for backfill
 * (idempotent re-registration) and for picking the next free nonce on
 * fresh creation (`max(nonce) + 1`).
 *
 * `MAX_PROBE` bounds the scan. No realistic Phase-1 user owns more than
 * a handful of companies; bump if a Phase-3 bulk-creation feature lands.
 */
const MAX_COMPANY_PROBE = 32;

export async function findCompaniesForWallet(
  userWallet: PublicKey,
): Promise<OnChainCompany[]> {
  const conn = getConnection();
  const candidates = Array.from({ length: MAX_COMPANY_PROBE }, (_, n) => ({
    nonce: n,
    pda: deriveCompanyPda(userWallet, n).pda,
  }));
  const infos = await conn.getMultipleAccountsInfo(
    candidates.map((c) => c.pda),
    "confirmed",
  );
  const out: OnChainCompany[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const info = infos[i];
    if (!info) continue;
    if (!info.owner.equals(REGISTRY_PROGRAM_ID)) {
      log.warn(
        {
          pda: candidates[i].pda.toBase58(),
          owner: info.owner.toBase58(),
        },
        "company PDA exists but owned by another program; skipping",
      );
      continue;
    }
    const data = info.data;
    if (data.length < COMPANY_MIN_LEN) {
      log.error(
        { pda: candidates[i].pda.toBase58(), len: data.length },
        "CompanyAccount too small; skipping",
      );
      continue;
    }
    out.push({
      companyPda: candidates[i].pda,
      owner: new PublicKey(
        data.subarray(COMPANY_OFFSET_OWNER, COMPANY_OFFSET_OWNER + 32),
      ),
      nonce: candidates[i].nonce,
    });
  }
  return out;
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
    owner: new PublicKey(
      data.subarray(COMPANY_OFFSET_OWNER, COMPANY_OFFSET_OWNER + 32),
    ),
    nonce: data.readUInt32LE(COMPANY_OFFSET_NONCE),
  };
}

// CompanyAccount recovery shape — full decode (name, locale, metadata)
// needed to reconstruct the `companies` row, beyond the lookup-only
// `OnChainCompany` returned by `findCompaniesForWallet`.
export interface OnChainCompanyFull {
  companyPda: PublicKey;
  owner: PublicKey;
  nonce: number;
  status: number;
  name: string;
  locale: string;
  metadataUri: string;
  metadataHash: Buffer;
}

export async function fetchCompanyForRecovery(
  companyPda: PublicKey,
): Promise<OnChainCompanyFull | null> {
  const conn = getConnection();
  const info = await conn.getAccountInfo(companyPda, "confirmed");
  if (!info) return null;
  if (!info.owner.equals(REGISTRY_PROGRAM_ID)) return null;
  if (!checkDiscriminator(info.data, ACCOUNT_DISCRIMINATOR.CompanyAccount)) {
    log.warn(
      { pda: companyPda.toBase58() },
      "fetchCompanyForRecovery: discriminator mismatch",
    );
    return null;
  }
  try {
    const c = new BorshCursor(info.data, 8);
    c.skip(1); // version
    const owner = c.readPubkey();
    c.skip(32); // treasury
    c.skip(32); // policy
    c.skip(8); // created_at
    c.skip(8); // updated_at
    const nonce = c.readU32();
    const status = c.readU8();
    const name = c.readString();
    const locale = c.readString();
    const metadataUri = c.readString();
    const metadataHash = c.readBytes32();
    return {
      companyPda,
      owner,
      nonce,
      status,
      name,
      locale,
      metadataUri,
      metadataHash,
    };
  } catch (err) {
    log.error(
      { pda: companyPda.toBase58(), err },
      "fetchCompanyForRecovery: decode failed",
    );
    return null;
  }
}

// AgentIdentity recovery shape — fields needed to reconstruct the
// `agent_identities` row. Not the full account; we skip what isn't required
// for DB rebuild (e.g. timestamps, reputation_uri Phase-2-only).
export interface OnChainAgentIdentity {
  identityPda: PublicKey;
  agentPubkey: PublicKey;
  owner: PublicKey;
  /** Personal receiving wallet (v2 layout). `PublicKey.default` = unset. */
  receivingAddress: PublicKey;
  name: string;
  metadataUri: string;
  metadataHash: Buffer;
}

export async function fetchAgentIdentity(
  identityPda: PublicKey,
): Promise<OnChainAgentIdentity | null> {
  const conn = getConnection();
  const info = await conn.getAccountInfo(identityPda, "confirmed");
  if (!info) return null;
  if (!info.owner.equals(REGISTRY_PROGRAM_ID)) {
    log.warn(
      { pda: identityPda.toBase58(), owner: info.owner.toBase58() },
      "fetchAgentIdentity: account not owned by registry program",
    );
    return null;
  }
  if (!checkDiscriminator(info.data, ACCOUNT_DISCRIMINATOR.AgentIdentity)) {
    log.warn(
      { pda: identityPda.toBase58() },
      "fetchAgentIdentity: discriminator mismatch",
    );
    return null;
  }
  try {
    const c = new BorshCursor(info.data, 8);
    c.skip(1); // version
    const agentPubkey = c.readPubkey();
    const owner = c.readPubkey();
    const receivingAddress = c.readPubkey(); // v2: personal receiving wallet
    c.skip(8); // created_at
    c.skip(8); // updated_at
    const name = c.readString();
    const metadataUri = c.readString();
    const metadataHash = c.readBytes32();
    return {
      identityPda,
      agentPubkey,
      owner,
      receivingAddress,
      name,
      metadataUri,
      metadataHash,
    };
  } catch (err) {
    log.error(
      { pda: identityPda.toBase58(), err },
      "fetchAgentIdentity: decode failed",
    );
    return null;
  }
}

// Deployment recovery shape — fields needed to reconstruct the
// `deployments` row + look up its identity for recursive recovery.
export interface OnChainDeployment {
  deploymentPda: PublicKey;
  agentIdentity: PublicKey;
  company: PublicKey;
  deploymentIndex: number;
  owner: PublicKey;
  receivingAddress: PublicKey;
  adapterId: PublicKey;
  role: string;
  parentDeploymentIndex: number | null;
  status: DeploymentStatus;
  metadataUri: string;
  metadataHash: Buffer;
}

export async function fetchDeployment(
  deploymentPda: PublicKey,
): Promise<OnChainDeployment | null> {
  const conn = getConnection();
  const info = await conn.getAccountInfo(deploymentPda, "confirmed");
  if (!info) return null;
  if (!info.owner.equals(REGISTRY_PROGRAM_ID)) {
    log.warn(
      { pda: deploymentPda.toBase58(), owner: info.owner.toBase58() },
      "fetchDeployment: account not owned by registry program",
    );
    return null;
  }
  if (!checkDiscriminator(info.data, ACCOUNT_DISCRIMINATOR.Deployment)) {
    log.warn(
      { pda: deploymentPda.toBase58() },
      "fetchDeployment: discriminator mismatch",
    );
    return null;
  }
  try {
    const c = new BorshCursor(info.data, 8);
    c.skip(1); // version
    const agentIdentity = c.readPubkey();
    const company = c.readPubkey();
    const deploymentIndex = c.readU32();
    const owner = c.readPubkey();
    const receivingAddress = c.readPubkey();
    const adapterId = c.readPubkey();
    const role = c.readString();
    const parentDeploymentIndex = c.readOptionU32();
    const statusByte = c.readU8();
    c.skip(8); // deployed_at
    c.skip(8); // retired_at
    c.skip(8); // updated_at
    const metadataUri = c.readString();
    const metadataHash = c.readBytes32();
    const status = (statusByte === DEPLOYMENT_STATUS.Paused
      ? DEPLOYMENT_STATUS.Paused
      : statusByte === DEPLOYMENT_STATUS.Retired
        ? DEPLOYMENT_STATUS.Retired
        : DEPLOYMENT_STATUS.Active) as DeploymentStatus;
    return {
      deploymentPda,
      agentIdentity,
      company,
      deploymentIndex,
      owner,
      receivingAddress,
      adapterId,
      role,
      parentDeploymentIndex,
      status,
      metadataUri,
      metadataHash,
    };
  } catch (err) {
    log.error(
      { pda: deploymentPda.toBase58(), err },
      "fetchDeployment: decode failed",
    );
    return null;
  }
}

// Per-company deployment_index is a packed u32 counter (mirrors PDA seed).
// Probe indices 0..N like we do for company nonces — single batched
// `getMultipleAccountsInfo` call. No global index, no `getProgramAccounts`.
const MAX_DEPLOYMENT_PROBE = 32;

export async function listDeploymentsByCompany(
  companyPda: PublicKey,
): Promise<OnChainDeployment[]> {
  const conn = getConnection();
  const candidates = Array.from(
    { length: MAX_DEPLOYMENT_PROBE },
    (_, idx) => ({
      deploymentIndex: idx,
      pda: deriveDeploymentPda(companyPda, idx).pda,
    }),
  );
  const infos = await conn.getMultipleAccountsInfo(
    candidates.map((c) => c.pda),
    "confirmed",
  );
  const out: OnChainDeployment[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const info = infos[i];
    if (!info) continue;
    if (!info.owner.equals(REGISTRY_PROGRAM_ID)) continue;
    if (!checkDiscriminator(info.data, ACCOUNT_DISCRIMINATOR.Deployment)) {
      continue;
    }
    try {
      const c = new BorshCursor(info.data, 8);
      c.skip(1); // version
      const agentIdentity = c.readPubkey();
      const company = c.readPubkey();
      const deploymentIndex = c.readU32();
      const owner = c.readPubkey();
      const receivingAddress = c.readPubkey();
      const adapterId = c.readPubkey();
      const role = c.readString();
      const parentDeploymentIndex = c.readOptionU32();
      const statusByte = c.readU8();
      c.skip(8 + 8 + 8); // deployed_at + retired_at + updated_at
      const metadataUri = c.readString();
      const metadataHash = c.readBytes32();
      const status = (statusByte === DEPLOYMENT_STATUS.Paused
        ? DEPLOYMENT_STATUS.Paused
        : statusByte === DEPLOYMENT_STATUS.Retired
          ? DEPLOYMENT_STATUS.Retired
          : DEPLOYMENT_STATUS.Active) as DeploymentStatus;
      out.push({
        deploymentPda: candidates[i].pda,
        agentIdentity,
        company,
        deploymentIndex,
        owner,
        receivingAddress,
        adapterId,
        role,
        parentDeploymentIndex,
        status,
        metadataUri,
        metadataHash,
      });
    } catch (err) {
      log.error(
        { pda: candidates[i].pda.toBase58(), err },
        "listDeploymentsByCompany: decode failed",
      );
    }
  }
  return out;
}
