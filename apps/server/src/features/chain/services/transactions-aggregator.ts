// Company-wide on-chain transaction list — aggregates signatures across
// every PDA a company touches (company / treasury / policy / 2 ops /
// per-deployment / per-day-anchor PDAs), decodes the first instruction's
// discriminator to a human label, returns the merged + deduped + sorted
// stream.
//
// Implementation: `getSignaturesForAddress` per PDA in parallel, dedupe
// by signature, sort by blockTime desc, take top N. Then
// `getTransaction` per kept signature to extract ix discriminator.
//
// Performance: O(PDAs) RPC calls for listing + O(N) for decoding. For a
// typical Phase 1 company with 5 agents that's ~10 list calls + 25
// decode calls per page. Acceptable on devnet; on mainnet swap for an
// indexer like Helius / Triton later.

import { PublicKey } from "@solana/web3.js";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  INSTRUCTION_DISCRIMINATOR,
  OPERATIONS_KIND,
  TREASURY_INSTRUCTION_DISCRIMINATOR,
  derivePolicyPda,
  deriveOperationsPda,
  deriveTreasuryPda,
} from "@occa/sdk";
import { db } from "../../../infra/database/client";
import { deployments } from "@occa/shared/schema";
import { getConnection } from "../../../infra/solana/connection";
import { childLogger } from "../../../lib/logger";

const log = childLogger("chain:transactions-aggregator");

// Per-PDA signature fetch cap. Kept tight so public devnet rate limits
// don't choke. Pagination via `before` cursor handles deeper history.
const PER_PDA_SIG_LIMIT = 25;

// 8-byte hex → action label. Concatenates Registry + Treasury programs
// so the lookup is one map regardless of which program owns the ix.
const IX_LABEL: Record<string, string> = {};
function register(disc: Buffer, label: string): void {
  IX_LABEL[disc.toString("hex")] = label;
}
register(INSTRUCTION_DISCRIMINATOR.createCompany, "Create company");
register(INSTRUCTION_DISCRIMINATOR.updateCompanyMetadata, "Update company metadata");
register(INSTRUCTION_DISCRIMINATOR.updateCompanyStatus, "Update company status");
register(INSTRUCTION_DISCRIMINATOR.registerAgentIdentity, "Register agent identity");
register(INSTRUCTION_DISCRIMINATOR.updateAgentIdentityMetadata, "Update identity metadata");
register(INSTRUCTION_DISCRIMINATOR.createDeployment, "Create deployment");
register(INSTRUCTION_DISCRIMINATOR.updateDeploymentMetadata, "Update deployment metadata");
register(INSTRUCTION_DISCRIMINATOR.updateDeploymentStatus, "Update deployment status");
register(INSTRUCTION_DISCRIMINATOR.retireDeployment, "Retire deployment");
register(INSTRUCTION_DISCRIMINATOR.setReceivingAddress, "Set receiving wallet");
register(INSTRUCTION_DISCRIMINATOR.commitDailyAnchor, "Daily anchor commit");
register(TREASURY_INSTRUCTION_DISCRIMINATOR.setPolicy, "Set policy");
register(TREASURY_INSTRUCTION_DISCRIMINATOR.disburseDiscretionary, "Manual payout");
register(TREASURY_INSTRUCTION_DISCRIMINATOR.initProtocolFeeAccount, "Init protocol fee account");
register(TREASURY_INSTRUCTION_DISCRIMINATOR.registerCompanyOperations, "Register operations");
register(TREASURY_INSTRUCTION_DISCRIMINATOR.updateOperationsCapability, "Update operations");
register(TREASURY_INSTRUCTION_DISCRIMINATOR.revokeOperations, "Pause operations");
register(TREASURY_INSTRUCTION_DISCRIMINATOR.closeOperations, "Disable operations");
register(TREASURY_INSTRUCTION_DISCRIMINATOR.disburseRoutine, "Auto-payout");
register(TREASURY_INSTRUCTION_DISCRIMINATOR.disbursePrivileged, "Privileged payout");
register(TREASURY_INSTRUCTION_DISCRIMINATOR.withdrawProtocolFees, "Withdraw fees");
register(TREASURY_INSTRUCTION_DISCRIMINATOR.setGovernance, "Set governance");
// SPL (USDC) siblings — multi-asset disbursement + fee withdrawal.
register(TREASURY_INSTRUCTION_DISCRIMINATOR.disburseRoutineSpl, "Auto-payout (USDC)");
register(TREASURY_INSTRUCTION_DISCRIMINATOR.disburseDiscretionarySpl, "Manual payout (USDC)");
register(TREASURY_INSTRUCTION_DISCRIMINATOR.disbursePrivilegedSpl, "Privileged payout (USDC)");
register(TREASURY_INSTRUCTION_DISCRIMINATOR.withdrawProtocolFeesSpl, "Withdraw fees (USDC)");

export interface CompanyTransactionRecord {
  signature: string;
  slot: number;
  /** Unix seconds. Null when the validator dropped it (rare). */
  blockTime: number | null;
  /** First-ix label derived from the 8-byte discriminator. `null` =
   *  not a known OCCA program ix (e.g. a manual SOL transfer to the
   *  treasury PDA), `"Unknown"` = OCCA program but unrecognized
   *  discriminator (forward-compat). */
  action: string | null;
  /** Tx failed on-chain (revert) when set. */
  err: string | null;
  /** First signer of the tx — usually the operator or owner. */
  signer: string | null;
}

export interface ListCompanyTransactionsResult {
  records: CompanyTransactionRecord[];
  /** True if there might be more older transactions beyond this batch.
   *  Implementation just flags "got max items" — caller can re-query
   *  with `before` for paging. */
  hasMore: boolean;
}

export async function listCompanyTransactions({
  companyPda,
  companyId,
  limit,
  before,
}: {
  companyPda: PublicKey;
  companyId: string;
  /** Max records to return. Capped at 100 server-side. */
  limit: number;
  /** Cursor — signature to page before (exclusive). */
  before?: string;
}): Promise<ListCompanyTransactionsResult> {
  const cappedLimit = Math.min(Math.max(limit, 1), 100);
  const conn = getConnection();

  // 1. Build the PDA set to scan.
  const treasuryPda = deriveTreasuryPda(companyPda).pda;
  const policyPda = derivePolicyPda(companyPda).pda;
  const opsDisbursementPda = deriveOperationsPda(
    companyPda,
    OPERATIONS_KIND.Disbursement,
  ).pda;
  const opsAnchorPda = deriveOperationsPda(
    companyPda,
    OPERATIONS_KIND.Anchor,
  ).pda;

  // Only anchored deployments have a real base58 deployment_pda — pre-anchor
  // rows carry a `dep_pda_<hex>` sentinel that breaks `new PublicKey(...)`.
  // Filter them out so the aggregator doesn't crash when a company has any
  // unanchored agents.
  const deploymentRows = await db
    .select({ deploymentPda: deployments.deploymentPda })
    .from(deployments)
    .where(
      and(
        eq(deployments.companyId, companyId),
        isNotNull(deployments.chainTxSignature),
      ),
    );

  const pdas: PublicKey[] = [
    companyPda,
    treasuryPda,
    policyPda,
    opsDisbursementPda,
    opsAnchorPda,
    ...deploymentRows.map((r) => new PublicKey(r.deploymentPda)),
  ];

  // 2. Parallel signature fetch per PDA. `before` is forwarded so paged
  //    requests narrow correctly.
  const allSigs = await Promise.all(
    pdas.map((pda) =>
      conn
        .getSignaturesForAddress(pda, { limit: PER_PDA_SIG_LIMIT, before })
        .catch((err) => {
          log.warn(
            { err, pda: pda.toBase58() },
            "getSignaturesForAddress failed (skipped)",
          );
          return [];
        }),
    ),
  );

  // 3. Merge + dedupe by signature. Keep the entry with non-null
  //    blockTime when duplicates differ.
  const bySig = new Map<
    string,
    { signature: string; slot: number; blockTime: number | null; err: string | null }
  >();
  for (const list of allSigs) {
    for (const sig of list) {
      const existing = bySig.get(sig.signature);
      if (!existing) {
        bySig.set(sig.signature, {
          signature: sig.signature,
          slot: sig.slot,
          blockTime: sig.blockTime ?? null,
          err: sig.err ? JSON.stringify(sig.err) : null,
        });
      } else if (existing.blockTime === null && sig.blockTime != null) {
        existing.blockTime = sig.blockTime;
      }
    }
  }

  // 4. Sort by blockTime desc (newest first), slot as tiebreaker.
  const merged = Array.from(bySig.values()).sort((a, b) => {
    const at = a.blockTime ?? 0;
    const bt = b.blockTime ?? 0;
    if (bt !== at) return bt - at;
    return b.slot - a.slot;
  });

  const hasMore = merged.length > cappedLimit;
  const page = merged.slice(0, cappedLimit);

  // 5. Resolve ix label + signer per signature. Low concurrency keeps
  //    public devnet rate limits happy — paid RPC (Helius/Triton) can
  //    bump this back up. Pagination splits load across requests anyway.
  const records: CompanyTransactionRecord[] = await mapWithConcurrency(
    page,
    2,
    async (item) => {
      try {
        const tx = await conn.getTransaction(item.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        if (!tx) {
          return {
            ...item,
            action: null,
            signer: null,
          };
        }

        // Pull first ix's program + discriminator. Versioned txs put ix
        // under `message.compiledInstructions`; legacy under
        // `message.instructions`. We just want the discriminator bytes.
        const msg = tx.transaction.message;
        const accountKeys = msg.getAccountKeys
          ? msg.getAccountKeys()
          : null;
        const signer = accountKeys
          ? accountKeys.get(0)?.toBase58() ?? null
          : null;

        const compiled =
          (msg as { compiledInstructions?: { programIdIndex: number; data: Uint8Array }[] })
            .compiledInstructions ?? [];
        const legacy =
          (msg as { instructions?: { programIdIndex: number; data: string | Buffer }[] })
            .instructions ?? [];

        let discriminatorHex: string | null = null;
        if (compiled.length > 0) {
          const ix = compiled[0];
          discriminatorHex = Buffer.from(ix.data.slice(0, 8)).toString("hex");
        } else if (legacy.length > 0) {
          const ix = legacy[0];
          const data =
            typeof ix.data === "string"
              ? Buffer.from(ix.data, "base64")
              : ix.data;
          discriminatorHex = data.subarray(0, 8).toString("hex");
        }

        const action = discriminatorHex
          ? IX_LABEL[discriminatorHex] ?? "Unknown"
          : null;

        return {
          ...item,
          action,
          signer,
        };
      } catch (err) {
        log.warn(
          { err, signature: item.signature },
          "getTransaction failed (showing without action label)",
        );
        return {
          ...item,
          action: null,
          signer: null,
        };
      }
    },
  );

  return { records, hasMore };
}

// Tiny concurrency limiter — avoid pumping 50 parallel getTransaction
// calls on free RPC.
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
