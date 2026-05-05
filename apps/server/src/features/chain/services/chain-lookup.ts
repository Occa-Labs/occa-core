import { PublicKey } from "@solana/web3.js";
import { REGISTRY_PROGRAM_ID, deriveCompanyPda } from "occa-sdk";
import { getConnection } from "../../../infra/solana/connection";
import { childLogger } from "../../../lib/logger";

const log = childLogger("chain:lookup");

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
