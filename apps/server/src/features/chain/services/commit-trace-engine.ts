// Commit-trace engine — anchors ONE verified deliverable on-chain via the
// Registry `commit_trace` ix. Per-deliverable provenance: content hash +
// verification verdict + quality score, attributable to the agent
// identity. Counterpart to daily-anchor-engine (a Merkle rollup of a
// day's traces); this fires per finished + verified task.
//
// Anchor Wallet signer (Phase 1): the operator keypair — same as the
// daily anchor + Disbursement signer. The company's Anchor
// OperationsAccount must have been registered with signer = operator.
//
// Gating (all must hold; otherwise a skip status — never throws):
//   - company is on-chain (companyPda present + valid)
//   - deployment is on-chain (real PDA, not a `dep_pda_<hex>` placeholder)
//   - company opted into anchoring: a healthy Anchor OperationsAccount
//   - the TraceAnchor PDA for this task isn't already committed
//
// Privacy: only hashes + an OPTIONAL result_uri go on-chain. A private
// deliverable anchors with resultUri = "" — content_hash proves the work
// existed + was verified without revealing it.

import { ComputeBudgetProgram, PublicKey, Transaction } from "@solana/web3.js";
import { eq } from "drizzle-orm";
import {
  INSTRUCTION_DISCRIMINATOR,
  OPERATIONS_KIND,
  buildCommitTraceInstruction,
  deriveOperationsPda,
  deriveTraceAnchorPda,
} from "@occa/sdk";
import { companies, deployments } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { getConnection } from "../../../infra/solana/connection";
import { getOperatorKeypair } from "../../../infra/solana/operator-signer";
import { childLogger } from "../../../lib/logger";
import { fetchAllOperationsState } from "./operations-lookup";
import { hashBytes } from "./merkle";

const log = childLogger("commit-trace-engine");

export interface CommitTraceInput {
  /** Owning company uuid. */
  companyId: string;
  /** OCCA task uuid — preimage for the deterministic on-chain task_id. */
  taskId: string;
  /** Assignee deployment uuid. */
  deploymentId: string;
  /** Clean deliverable text — hashed into content_hash. */
  deliverable: string;
  /** Public link to the deliverable, or "" for private / no-publish work. */
  resultUri: string;
  /** SHA-256 of the verification report, hex (64 chars). */
  evidenceHashHex: string;
  /** Rubric quality score 0-100. */
  qualityScore: number;
  /** Version of the scoring rubric that produced `qualityScore`. */
  rubricVersion: number;
  /** Unix seconds the deliverable settled. Must be > 0 and ≤ now. */
  completedAt: number;
}

export type CommitTraceStatus =
  | "anchored"
  | "already_anchored"
  | "skipped_company_offchain"
  | "skipped_deployment_offchain"
  | "skipped_no_anchor_ops"
  | "skipped_not_whitelisted"
  | "failed";

export interface CommitTraceResult {
  status: CommitTraceStatus;
  signature: string | null;
  traceAnchorPda: string | null;
  error: string | null;
}

// Deterministic 32-byte task_id from companyId + taskId. Company is in the
// preimage for global uniqueness — the TraceAnchor PDA is keyed solely on
// task_id (no company prefix in the seed).
function deriveTaskIdBytes(companyId: string, taskId: string): Buffer {
  return hashBytes(Buffer.from(`${companyId}:${taskId}`, "utf8"));
}

/**
 * Anchor one verified deliverable. Best-effort: returns a status rather
 * than throwing, so a chain hiccup never breaks task completion. Callers
 * fire-and-forget.
 */
export async function commitTraceForTask(
  input: CommitTraceInput,
): Promise<CommitTraceResult> {
  const fail = (
    status: CommitTraceStatus,
    extra?: Partial<CommitTraceResult>,
  ): CommitTraceResult => ({
    status,
    signature: null,
    traceAnchorPda: null,
    error: null,
    ...extra,
  });

  // Resolve company on-chain.
  const [company] = await db
    .select({ id: companies.id, companyPda: companies.companyPda })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1);
  if (!company?.companyPda) return fail("skipped_company_offchain");
  let companyPda: PublicKey;
  try {
    companyPda = new PublicKey(company.companyPda);
  } catch {
    return fail("skipped_company_offchain");
  }

  // Resolve deployment on-chain (skip unfinished `dep_pda_<hex>` rows).
  const [dep] = await db
    .select({ id: deployments.id, deploymentPda: deployments.deploymentPda })
    .from(deployments)
    .where(eq(deployments.id, input.deploymentId))
    .limit(1);
  if (!dep?.deploymentPda) return fail("skipped_deployment_offchain");
  let deploymentPda: PublicKey;
  try {
    deploymentPda = new PublicKey(dep.deploymentPda);
  } catch {
    return fail("skipped_deployment_offchain");
  }

  // Precondition: healthy Anchor OperationsAccount (= company opted into
  // on-chain anchoring). Same gate as daily-anchor-engine.
  const operator = getOperatorKeypair();
  const opsStates = await fetchAllOperationsState(companyPda);
  const anchorOps = opsStates.find((o) => o.kind === OPERATIONS_KIND.Anchor);
  const nowSec = Math.floor(Date.now() / 1000);
  const expiry = anchorOps ? Number(anchorOps.expiryUnix) : 0;
  if (
    !anchorOps?.exists ||
    anchorOps.revoked ||
    anchorOps.signer !== operator.publicKey.toBase58() ||
    (expiry !== 0 && nowSec >= expiry)
  ) {
    return fail("skipped_no_anchor_ops");
  }
  // The Anchor ops must whitelist commit_trace specifically — the chain
  // rejects an un-whitelisted discriminator. Skip cleanly rather than
  // sending a doomed tx (a company set up before commit_trace existed will
  // have only commit_daily_anchor; the operator re-whitelists via
  // update_operations_capability).
  const commitTraceDisc = INSTRUCTION_DISCRIMINATOR.commitTrace.toString("hex");
  if (!anchorOps.actionWhitelist.includes(commitTraceDisc)) {
    return fail("skipped_not_whitelisted");
  }
  const anchorOperationsPda = deriveOperationsPda(
    companyPda,
    OPERATIONS_KIND.Anchor,
  ).pda;

  // Idempotency: chain rejects a re-commit (PDA seed is task_id), but a
  // pre-check avoids burning a tx + logs a friendlier status.
  const conn = getConnection();
  const taskIdBytes = deriveTaskIdBytes(input.companyId, input.taskId);
  const { pda: traceAnchorPda } = deriveTraceAnchorPda(taskIdBytes);
  const existing = await conn.getAccountInfo(traceAnchorPda);
  if (existing) {
    return {
      status: "already_anchored",
      signature: null,
      traceAnchorPda: traceAnchorPda.toBase58(),
      error: null,
    };
  }

  const contentHash = hashBytes(Buffer.from(input.deliverable, "utf8"));
  const evidenceHash = Buffer.from(input.evidenceHashHex, "hex");

  try {
    const { instruction } = buildCommitTraceInstruction({
      deploymentPda,
      companyPda,
      anchorSigner: operator.publicKey,
      operationsPda: anchorOperationsPda,
      taskId: taskIdBytes,
      resultUri: input.resultUri,
      contentHash,
      qualityScore: input.qualityScore,
      rubricVersion: input.rubricVersion,
      evidenceHash,
      completedAt: BigInt(input.completedAt),
      payer: operator.publicKey,
    });

    const { blockhash, lastValidBlockHeight } =
      await conn.getLatestBlockhash("confirmed");
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
    log.info(
      { taskId: input.taskId, traceAnchorPda: traceAnchorPda.toBase58(), sig },
      "commit_trace anchored",
    );
    return {
      status: "anchored",
      signature: sig,
      traceAnchorPda: traceAnchorPda.toBase58(),
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, taskId: input.taskId }, "commit_trace tx failed");
    return {
      status: "failed",
      signature: null,
      traceAnchorPda: traceAnchorPda.toBase58(),
      error: message,
    };
  }
}
