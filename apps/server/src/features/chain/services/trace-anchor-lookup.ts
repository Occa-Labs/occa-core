// TraceAnchor reads — list all per-deliverable provenance commits for a
// company. Backs the operator-facing Provenance view in OCCA OS.
//
// Same approach as daily-anchor-lookup: `getProgramAccounts` with a memcmp
// on the `company` field. Devnet-fine; on mainnet swap for an indexer or a
// DB cache populated when commit_trace lands.

import { PublicKey } from "@solana/web3.js";
import { eq, inArray } from "drizzle-orm";
import { ACCOUNT_DISCRIMINATOR, REGISTRY_PROGRAM_ID } from "@occa/sdk";
import { agentIdentities, deployments } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { getConnection } from "../../../infra/solana/connection";
import { childLogger } from "../../../lib/logger";
import { decodeTrace, type TraceAnchorRecord } from "./reputation-lookup";

const log = childLogger("chain:trace-anchor-lookup");

// Byte offset of TraceAnchorAccount.company within the account data:
//   discriminator(8) + version(1) + task_id(32) = 41
const TRACE_COMPANY_OFFSET = 41;

export interface TraceAnchorListItem extends TraceAnchorRecord {
  /** Agent display name resolved from the deployment row, when available. */
  agentName: string | null;
  /** Slugged role from the deployment row, when available. */
  agentRole: string | null;
}

export async function listCompanyTraceAnchors(
  companyPda: PublicKey,
): Promise<TraceAnchorListItem[]> {
  const conn = getConnection();

  const accounts = await conn.getProgramAccounts(REGISTRY_PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: Buffer.from(
            ACCOUNT_DISCRIMINATOR.TraceAnchorAccount,
          ).toString("base64"),
          encoding: "base64",
        },
      },
      {
        memcmp: {
          offset: TRACE_COMPANY_OFFSET,
          bytes: companyPda.toBase58(),
        },
      },
    ],
  });

  log.info(
    { companyPda: companyPda.toBase58(), count: accounts.length },
    "list company trace anchors",
  );

  const decoded = accounts
    .map(({ pubkey, account }) =>
      decodeTrace(pubkey.toBase58(), account.data as Buffer),
    )
    .filter((r): r is TraceAnchorRecord => r !== null);

  const records: TraceAnchorListItem[] = decoded.map((r) => ({
    ...r,
    agentName: null,
    agentRole: null,
  }));

  // Resolve deployment PDA → agent name in one DB pass.
  const deploymentPdas = Array.from(new Set(records.map((r) => r.deployment)));
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
      const row = byPda.get(rec.deployment);
      if (row) {
        rec.agentName = row.agentName;
        rec.agentRole = row.agentRole;
      }
    }
  }

  // Newest first by on-chain commit time.
  records.sort((a, b) => b.committedAt - a.committedAt);
  return records;
}
