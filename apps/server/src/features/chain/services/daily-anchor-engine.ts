// Daily anchor engine — commits one Merkle root per (deployment, UTC day)
// to the Registry program via `commit_daily_anchor`.
//
// Anchor Wallet signer (Phase 1): same operator keypair as fee payer
// and the Disbursement Wallet signer. The company's Anchor
// OperationsAccount must therefore have been registered with
// `signer = operator.publicKey`. Phase 2 splits this into per-company
// encrypted Anchor keys.
//
// Idempotency: chain itself prevents double-commit (DailyAnchor PDA seed
// is `(deployment, day_unix)`). We pre-check account existence to avoid
// burning RPC + log a friendlier "already anchored" result.
//
// Empty days: skipped entirely. Whitepaper §2 / program handler require
// `task_count > 0`, so days with no completed traces produce no anchor.

import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { and, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import {
  OPERATIONS_KIND,
  buildCommitDailyAnchorInstruction,
  deriveDailyAnchorPda,
  deriveOperationsPda,
} from "@occa/sdk";
import {
  companies,
  deployments,
  traces,
} from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { getConnection } from "../../../infra/solana/connection";
import { getOperatorKeypair } from "../../../infra/solana/operator-signer";
import { childLogger } from "../../../lib/logger";
import { fetchAllOperationsState } from "./operations-lookup";
import { hashBytes, merkleRoot } from "./merkle";

const log = childLogger("daily-anchor-engine");

export const SECONDS_PER_DAY = 86_400;

// Only traces from these `invocation_source` values count as auditable
// work units. Excludes:
//   - "chat"       — user↔CEO and agent-to-agent DM. Communication, not
//                    work; sensitive content shouldn't leak into the
//                    public Merkle root via metadata fingerprint.
//   - "skill_sync" — system-side skill ingestion, has no work output.
//   - "on_demand"  — default/manual trigger, ambiguous; not anchored
//                    until the caller explicitly tags it as task/review.
//
// Add new sources here ONLY if they represent agent work output that
// belongs in the on-chain audit trail. Bumping this set is a chain-
// format change — verifiers depending on the leaf hash composition
// will see prior anchors stay valid (we don't re-hash), but new anchors
// will cover a different leaf set. Document the day of the cut-over.
const ANCHORABLE_INVOCATION_SOURCES = ["task", "review"] as const;

export interface AnchorResult {
  deploymentId: string;
  deploymentPda: string;
  dayUnix: number;
  taskCount: number;
  signature: string | null;
  /**
   * - `anchored`: new DailyAnchor tx submitted.
   * - `already_anchored`: PDA already exists for this day.
   * - `no_traces`: nothing to anchor today.
   * - `skipped_invalid_pda`: deployment row carries a `dep_pda_<hex>`
   *   placeholder — on-chain register-deployment tx never completed for
   *   this deployment. Heal via /register-combined/prepare from the OS.
   * - `failed`: anything else (RPC error, signer failure, etc).
   */
  status:
    | "anchored"
    | "already_anchored"
    | "no_traces"
    | "skipped_invalid_pda"
    | "failed";
  error: string | null;
}

export interface CompanyAnchorSkip {
  companyId: string;
  reason:
    | "no_anchor_ops"
    | "ops_revoked"
    | "ops_signer_mismatch"
    | "ops_expired"
    | "no_active_deployments";
}

export interface RunSummary {
  dayUnix: number;
  /** Sum of new anchor txs submitted this run. */
  anchored: number;
  /** Deployment-days skipped because already anchored. */
  alreadyAnchored: number;
  /** Days with zero completed traces. */
  skippedEmpty: number;
  /** Deployments whose on-chain register-deployment never completed. */
  skippedInvalidPda: number;
  /** Per-tx failures. */
  failed: number;
  /** Companies that didn't qualify at all (precondition skip). */
  companiesSkipped: CompanyAnchorSkip[];
  results: AnchorResult[];
}

/**
 * Snap an arbitrary unix-seconds timestamp DOWN to the start of its UTC
 * day (00:00:00 UTC). Caller usually passes `now`.
 */
export function startOfUtcDay(unixSeconds: number): number {
  return Math.floor(unixSeconds / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

interface TraceForHash {
  id: string;
  taskId: string | null;
  deploymentId: string;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  skillsUsed: unknown;
}

/**
 * Canonical bytes for one trace, hashed into a Merkle leaf. Deterministic
 * — same input always produces the same digest. Schema changes MUST bump
 * this format (chain re-verification depends on stable hashing).
 */
function canonicalTraceBytes(t: TraceForHash): Buffer {
  // Sorted-key JSON keeps the bytes stable across V8 versions / DB
  // drivers that don't guarantee key ordering.
  const obj = {
    deploymentId: t.deploymentId,
    finishedAt: t.finishedAt?.toISOString() ?? null,
    id: t.id,
    skillsUsed: t.skillsUsed ?? [],
    startedAt: t.startedAt?.toISOString() ?? null,
    status: t.status,
    taskId: t.taskId ?? null,
  };
  return Buffer.from(JSON.stringify(obj), "utf8");
}

/**
 * Anchor one (deployment, day) pair. Caller is responsible for ensuring
 * the company's Anchor OperationsAccount preconditions are met.
 */
async function anchorOneDeploymentDay(args: {
  deploymentId: string;
  deploymentPda: PublicKey;
  companyPda: PublicKey;
  anchorOperationsPda: PublicKey;
  dayUnix: number;
}): Promise<AnchorResult> {
  const { deploymentId, deploymentPda, companyPda, anchorOperationsPda } = args;
  const dayUnix = args.dayUnix;
  const base = {
    deploymentId,
    deploymentPda: deploymentPda.toBase58(),
    dayUnix,
  };

  // Pre-check: PDA already on-chain? Saves a tx if we somehow re-run for
  // a day that was already committed.
  const conn = getConnection();
  const { pda: dailyAnchorPda } = deriveDailyAnchorPda(
    deploymentPda,
    BigInt(dayUnix),
  );
  const existing = await conn.getAccountInfo(dailyAnchorPda);
  if (existing) {
    return {
      ...base,
      taskCount: 0,
      signature: null,
      status: "already_anchored",
      error: null,
    };
  }

  const windowStart = new Date(dayUnix * 1000);
  const windowEnd = new Date((dayUnix + SECONDS_PER_DAY) * 1000);

  // Pull succeeded traces within the UTC-day window. Status filter is
  // intentionally narrow: only `succeeded` counts as a billable work
  // unit. `failed`/`timed_out` are excluded — they exist as evidence
  // but don't represent finished work the agent did. Source filter
  // restricts to auditable work (see ANCHORABLE_INVOCATION_SOURCES) so
  // chat / skill-sync traces don't bloat the Merkle root.
  const rows = await db
    .select({
      id: traces.id,
      taskId: traces.taskId,
      deploymentId: traces.deploymentId,
      status: traces.status,
      startedAt: traces.startedAt,
      finishedAt: traces.finishedAt,
      skillsUsed: traces.skillsUsed,
    })
    .from(traces)
    .where(
      and(
        eq(traces.deploymentId, deploymentId),
        eq(traces.status, "succeeded"),
        inArray(
          traces.invocationSource,
          ANCHORABLE_INVOCATION_SOURCES as unknown as string[],
        ),
        isNotNull(traces.finishedAt),
        gte(traces.finishedAt, windowStart),
        lt(traces.finishedAt, windowEnd),
      ),
    )
    .orderBy(traces.finishedAt);

  if (rows.length === 0) {
    return {
      ...base,
      taskCount: 0,
      signature: null,
      status: "no_traces",
      error: null,
    };
  }

  const leaves = rows.map((r) => hashBytes(canonicalTraceBytes(r)));
  const root = merkleRoot(leaves);

  const operator = getOperatorKeypair();
  try {
    const { instruction } = buildCommitDailyAnchorInstruction({
      deploymentPda,
      companyPda,
      anchorSigner: operator.publicKey,
      operationsPda: anchorOperationsPda,
      dayUnix: BigInt(dayUnix),
      merkleRoot: root,
      taskCount: rows.length,
      payer: operator.publicKey,
    });

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(
      "confirmed",
    );
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
    tx.add(instruction);
    tx.recentBlockhash = blockhash;
    tx.feePayer = operator.publicKey;
    tx.sign(operator);

    const sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      preflightCommitment: "confirmed",
    });
    await conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    return {
      ...base,
      taskCount: rows.length,
      signature: sig,
      status: "anchored",
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, deploymentId, dayUnix },
      "commit_daily_anchor tx failed",
    );
    return {
      ...base,
      taskCount: rows.length,
      signature: null,
      status: "failed",
      error: message,
    };
  }
}

/**
 * Anchor all chain-anchored deployments for the given UTC day.
 *
 * Per-company precondition check: must have an Anchor OperationsAccount
 * registered with signer == operator. Companies failing this are added
 * to `companiesSkipped` with a reason code; their deployments are not
 * attempted.
 */
export async function runDailyAnchor(dayUnix: number): Promise<RunSummary> {
  if (dayUnix % SECONDS_PER_DAY !== 0) {
    throw new Error(
      `runDailyAnchor: dayUnix must be aligned to UTC midnight (got ${dayUnix})`,
    );
  }

  const operator = getOperatorKeypair();
  const operatorBase58 = operator.publicKey.toBase58();

  // All chain-anchored companies — companies without a companyPda haven't
  // hit chain yet, nothing to anchor.
  const companyRows = await db
    .select({
      id: companies.id,
      companyPda: companies.companyPda,
    })
    .from(companies)
    .where(
      and(
        isNotNull(companies.companyPda),
        isNull(companies.deletedAt),
        // Paused companies (non-NULL paused_at) skip the anchor — their
        // agents aren't producing new work this period.
        isNull(companies.pausedAt),
      ),
    );

  const summary: RunSummary = {
    dayUnix,
    anchored: 0,
    alreadyAnchored: 0,
    skippedEmpty: 0,
    skippedInvalidPda: 0,
    failed: 0,
    companiesSkipped: [],
    results: [],
  };

  for (const company of companyRows) {
    if (!company.companyPda) continue;
    const companyPda = new PublicKey(company.companyPda);

    // Precondition: Anchor OperationsAccount healthy.
    const opsStates = await fetchAllOperationsState(companyPda);
    const anchor = opsStates.find(
      (o) => o.kind === OPERATIONS_KIND.Anchor,
    );
    if (!anchor?.exists) {
      summary.companiesSkipped.push({
        companyId: company.id,
        reason: "no_anchor_ops",
      });
      continue;
    }
    if (anchor.revoked) {
      summary.companiesSkipped.push({
        companyId: company.id,
        reason: "ops_revoked",
      });
      continue;
    }
    if (anchor.signer !== operatorBase58) {
      summary.companiesSkipped.push({
        companyId: company.id,
        reason: "ops_signer_mismatch",
      });
      continue;
    }
    const expiry = Number(anchor.expiryUnix);
    const nowSec = Math.floor(Date.now() / 1000);
    if (expiry !== 0 && nowSec >= expiry) {
      summary.companiesSkipped.push({
        companyId: company.id,
        reason: "ops_expired",
      });
      continue;
    }

    const anchorOperationsPda = deriveOperationsPda(
      companyPda,
      OPERATIONS_KIND.Anchor,
    ).pda;

    // Active deployments only — paused/retired don't generate new work.
    const deploymentRows = await db
      .select({
        id: deployments.id,
        deploymentPda: deployments.deploymentPda,
      })
      .from(deployments)
      .where(
        and(
          eq(deployments.companyId, company.id),
          eq(deployments.status, "active"),
        ),
      );

    if (deploymentRows.length === 0) {
      summary.companiesSkipped.push({
        companyId: company.id,
        reason: "no_active_deployments",
      });
      continue;
    }

    for (const dep of deploymentRows) {
      // Deployment rows are inserted with a `dep_pda_<48hex>` placeholder
      // when the DB row is created, and overwritten with the real PDA
      // after the on-chain register-deployment tx confirms. If the user
      // ever bailed out of the sign step, the placeholder stays. Skip
      // these explicitly (warn, not error) — they self-heal once the user
      // re-runs /register-combined/prepare from the OS.
      let deploymentPdaKey: PublicKey;
      try {
        deploymentPdaKey = new PublicKey(dep.deploymentPda);
      } catch {
        log.warn(
          { deploymentId: dep.id, deploymentPda: dep.deploymentPda },
          "skipping deployment with unfinished on-chain registration",
        );
        const skipped: AnchorResult = {
          deploymentId: dep.id,
          deploymentPda: dep.deploymentPda,
          dayUnix,
          taskCount: 0,
          signature: null,
          status: "skipped_invalid_pda",
          error: null,
        };
        summary.results.push(skipped);
        summary.skippedInvalidPda += 1;
        continue;
      }

      // Per-deployment try/catch: a single failing anchor (RPC blip,
      // signer drop) must not abort the whole run for the rest of the
      // company / other companies. Record as failed and continue.
      let result: AnchorResult;
      try {
        result = await anchorOneDeploymentDay({
          deploymentId: dep.id,
          deploymentPda: deploymentPdaKey,
          companyPda,
          anchorOperationsPda,
          dayUnix,
        });
      } catch (err) {
        log.error(
          { err, deploymentId: dep.id, deploymentPda: dep.deploymentPda },
          "anchor failed unexpectedly for deployment",
        );
        result = {
          deploymentId: dep.id,
          deploymentPda: dep.deploymentPda,
          dayUnix,
          taskCount: 0,
          signature: null,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      summary.results.push(result);
      if (result.status === "anchored") summary.anchored += 1;
      else if (result.status === "already_anchored") summary.alreadyAnchored += 1;
      else if (result.status === "no_traces") summary.skippedEmpty += 1;
      else summary.failed += 1;
    }
  }

  log.info(
    {
      dayUnix,
      anchored: summary.anchored,
      alreadyAnchored: summary.alreadyAnchored,
      skippedEmpty: summary.skippedEmpty,
      skippedInvalidPda: summary.skippedInvalidPda,
      failed: summary.failed,
      companiesSkipped: summary.companiesSkipped.length,
    },
    "daily anchor run complete",
  );

  return summary;
}
