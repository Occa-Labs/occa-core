// DailyAnchor reads — list all on-chain daily anchor commits for a
// company. Backs the operator-facing Anchors view in OCCA OS.
//
// Implementation: `getProgramAccounts` with memcmp on the `company` field
// returns every DailyAnchorAccount belonging to this company in one RPC.
// Acceptable on devnet; on mainnet most RPC providers gate this method
// behind a paid tier — when we migrate, swap this for an indexer-backed
// query or a DB cache populated by the commit cron.

import { PublicKey } from "@solana/web3.js";
import { eq, inArray } from "drizzle-orm";
import { ACCOUNT_DISCRIMINATOR, REGISTRY_PROGRAM_ID } from "@occa/sdk";
import { getConnection } from "../../../infra/solana/connection";
import { childLogger } from "../../../lib/logger";
import { db } from "../../../infra/database/client";
import { agentIdentities, deployments } from "@occa/shared/schema";

const log = childLogger("chain:daily-anchor-lookup");

// DailyAnchorAccount field offsets (after 8-byte Anchor discriminator).
// Layout (matches `DailyAnchorAccount` in occa-programs/registry/lib.rs):
//   version: u8           (offset 0, 1 byte)
//   deployment: Pubkey    (offset 1, 32 bytes)
//   company: Pubkey       (offset 33, 32 bytes)
//   day_unix: i64         (offset 65, 8 bytes)
//   merkle_root: [u8; 32] (offset 73, 32 bytes)
//   task_count: u32       (offset 105, 4 bytes)
//   committed_at: i64     (offset 109, 8 bytes)
//   committed_by: Pubkey  (offset 117, 32 bytes)
//   bump: u8              (offset 149, 1 byte)
const FIELD_OFFSET = {
  version: 0,
  deployment: 1,
  company: 33,
  dayUnix: 65,
  merkleRoot: 73,
  taskCount: 105,
  committedAt: 109,
  committedBy: 117,
  bump: 149,
} as const;

const ACCOUNT_DATA_SIZE = FIELD_OFFSET.bump + 1; // 150 bytes after discriminator

export interface DailyAnchorRecord {
  pda: string;
  deploymentPda: string;
  /** Agent display name resolved from the deployment row, when available. */
  agentName: string | null;
  /** Slugged role from the deployment row, when available. */
  agentRole: string | null;
  /** Unix seconds of 00:00:00 UTC of the anchored day. */
  dayUnix: number;
  /** Hex-encoded SHA-256 Merkle root (lowercase, no 0x prefix). */
  merkleRoot: string;
  taskCount: number;
  /** Unix seconds when the commit landed on chain. */
  committedAt: number;
  /** Anchor Wallet pubkey that signed the commit. */
  committedBy: string;
}

function decode(data: Buffer, pda: PublicKey): DailyAnchorRecord {
  const o = FIELD_OFFSET;
  const offset = 8; // skip Anchor discriminator
  const deployment = new PublicKey(
    data.subarray(offset + o.deployment, offset + o.deployment + 32),
  );
  const dayUnix = Number(
    data.readBigInt64LE(offset + o.dayUnix),
  );
  const merkleRoot = data
    .subarray(offset + o.merkleRoot, offset + o.merkleRoot + 32)
    .toString("hex");
  const taskCount = data.readUInt32LE(offset + o.taskCount);
  const committedAt = Number(
    data.readBigInt64LE(offset + o.committedAt),
  );
  const committedBy = new PublicKey(
    data.subarray(offset + o.committedBy, offset + o.committedBy + 32),
  );

  return {
    pda: pda.toBase58(),
    deploymentPda: deployment.toBase58(),
    agentName: null,
    agentRole: null,
    dayUnix,
    merkleRoot,
    taskCount,
    committedAt,
    committedBy: committedBy.toBase58(),
  };
}

export async function listCompanyDailyAnchors(
  companyPda: PublicKey,
): Promise<DailyAnchorRecord[]> {
  const conn = getConnection();

  // memcmp filter on the `company` field. Server-side filter cuts wire
  // load even though the RPC still scans the full program account set.
  const accounts = await conn.getProgramAccounts(REGISTRY_PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: Buffer.from(ACCOUNT_DISCRIMINATOR.DailyAnchorAccount).toString(
            "base64",
          ),
          encoding: "base64",
        },
      },
      {
        memcmp: {
          offset: 8 + FIELD_OFFSET.company,
          bytes: companyPda.toBase58(),
        },
      },
    ],
  });

  log.info(
    { companyPda: companyPda.toBase58(), count: accounts.length },
    "list company daily anchors",
  );

  const records = accounts
    .filter(({ account }) => account.data.length >= 8 + ACCOUNT_DATA_SIZE)
    .map(({ pubkey, account }) => decode(account.data, pubkey));

  // Resolve deployment PDA → agent name in one DB pass.
  const deploymentPdas = Array.from(
    new Set(records.map((r) => r.deploymentPda)),
  );
  if (deploymentPdas.length > 0) {
    const rows = await db
      .select({
        deploymentPda: deployments.deploymentPda,
        agentName: agentIdentities.name,
        agentRole: deployments.role,
      })
      .from(deployments)
      .innerJoin(
        agentIdentities,
        eq(agentIdentities.id, deployments.agentIdentityId),
      )
      .where(inArray(deployments.deploymentPda, deploymentPdas));

    const byPda = new Map(rows.map((r) => [r.deploymentPda, r]));
    for (const rec of records) {
      const row = byPda.get(rec.deploymentPda);
      if (row) {
        rec.agentName = row.agentName;
        rec.agentRole = row.agentRole;
      }
    }
  }

  // Newest first by commit-on-chain timestamp.
  records.sort((a, b) => b.committedAt - a.committedAt);
  return records;
}
