// Routine payout engine — autonomously executes pending agent payouts
// via `disburse_routine` (no owner-wallet popup; signed by the
// Disbursement Wallet bound to the company's OperationsAccount).
//
// Phase 1 simplification: the operator hot wallet plays TWO roles —
//   1. Fee payer for the tx
//   2. Disbursement Wallet signer (signs disburse_routine)
// This means whoever registers operations must call register with
// `signer = operator.publicKey`. Phase 2 will introduce per-company
// encrypted keys so the operator wallet stops being a single-point-of-
// trust across companies.
//
// Trigger model: manual for now — `POST /api/chain/companies/:id/payouts/run`.
// Cron scheduling lands in a follow-up slice (independent decision, no
// business-logic change).

import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  OPERATIONS_KIND,
  SOL_PSEUDO_MINT,
  buildDisburseRoutineInstruction,
  buildDisburseRoutineSplInstruction,
  deriveOperationsPda,
  derivePolicyPda,
  deriveTreasuryPda,
} from "@occa/sdk";
import { getConnection } from "../../../infra/solana/connection";
import { getOperatorKeypair } from "../../../infra/solana/operator-signer";
import { childLogger } from "../../../lib/logger";
import { fetchAllOperationsState } from "../../chain/services/operations-lookup";
import { markInvoicesPaid } from "../repositories/invoices";
import {
  buildDisbursementPlan,
  type AgentDisbursement,
} from "./disbursement";

const log = childLogger("payout-engine");

export interface PayoutResult {
  deploymentId: string;
  agentName: string;
  invoiceIds: string[];
  totalLamports: number;
  /** Solana tx signature on success. */
  signature: string | null;
  /** Human-readable failure reason on error. */
  error: string | null;
}

export interface PayoutRunSummary {
  /** Sum of successful payouts (lamports). */
  paidLamports: number;
  /** Count of invoices flipped to paid. */
  paidInvoiceCount: number;
  /** Count of payouts that failed mid-flight. */
  failureCount: number;
  results: PayoutResult[];
}

export class PayoutPreconditionError extends Error {
  constructor(
    public readonly code:
      | "no_disbursement_ops"
      | "ops_revoked"
      | "ops_signer_mismatch"
      | "ops_expired"
      | "company_not_anchored",
    message: string,
  ) {
    super(message);
    this.name = "PayoutPreconditionError";
  }
}

/**
 * Run the routine payout for one company.
 *
 * Preconditions:
 *   • Company has a Disbursement OperationsAccount registered + not revoked
 *   • Operations.signer == operator.publicKey (Phase 1 invariant)
 *   • Operations not expired
 *
 * One tx per payable agent — failures isolated (one tx blowing up
 * doesn't poison the rest). Each successful tx flips its invoices to
 * `paid` with the signature stamped. Blocked agents (no receiving
 * address) are surfaced in the results but not attempted.
 */
export async function runRoutinePayouts(args: {
  companyId: string;
  companyPda: PublicKey;
}): Promise<PayoutRunSummary> {
  const { companyId, companyPda } = args;
  const operator = getOperatorKeypair();

  // ── Precondition: Disbursement ops registered + healthy ───────────────
  const opsStates = await fetchAllOperationsState(companyPda);
  const disbursement = opsStates.find(
    (o) => o.kind === OPERATIONS_KIND.Disbursement,
  );
  if (!disbursement?.exists) {
    throw new PayoutPreconditionError(
      "no_disbursement_ops",
      "no Disbursement OperationsAccount — register one first",
    );
  }
  if (disbursement.revoked) {
    throw new PayoutPreconditionError(
      "ops_revoked",
      "Disbursement OperationsAccount is revoked",
    );
  }
  if (disbursement.signer !== operator.publicKey.toBase58()) {
    throw new PayoutPreconditionError(
      "ops_signer_mismatch",
      `Disbursement signer (${disbursement.signer}) is not the operator key (${operator.publicKey.toBase58()}). Phase 1 requires operator to be the signer.`,
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const expiry = Number(disbursement.expiryUnix);
  if (expiry !== 0 && now >= expiry) {
    throw new PayoutPreconditionError(
      "ops_expired",
      "Disbursement OperationsAccount has expired",
    );
  }

  // ── Plan ──────────────────────────────────────────────────────────────
  const plan = await buildDisbursementPlan(companyId);
  if (plan.payable.length === 0) {
    log.info({ companyId }, "no payable agents — nothing to do");
    return {
      paidLamports: 0,
      paidInvoiceCount: 0,
      failureCount: 0,
      results: [],
    };
  }

  // ── Execute, one tx per payable ───────────────────────────────────────
  const treasuryPda = deriveTreasuryPda(companyPda).pda;
  const policyPda = derivePolicyPda(companyPda).pda;
  const operationsPda = deriveOperationsPda(
    companyPda,
    OPERATIONS_KIND.Disbursement,
  ).pda;
  const conn = getConnection();

  const results: PayoutResult[] = [];
  let paidLamports = 0;
  let paidInvoiceCount = 0;
  let failureCount = 0;

  for (const agent of plan.payable) {
    const result = await executeOnePayout({
      agent,
      companyPda,
      treasuryPda,
      policyPda,
      operationsPda,
      operator,
      connection: conn,
    });
    results.push(result);
    if (result.error) {
      failureCount += 1;
      continue;
    }
    if (result.signature) {
      const flipped = await markInvoicesPaid(agent.invoiceIds, result.signature);
      paidLamports += agent.totalLamports;
      paidInvoiceCount += flipped;
    }
  }

  log.info(
    {
      companyId,
      paidLamports,
      paidInvoiceCount,
      failureCount,
      attemptedAgents: plan.payable.length,
      blockedAgents: plan.blocked.length,
    },
    "routine payout run complete",
  );

  return {
    paidLamports,
    paidInvoiceCount,
    failureCount,
    results,
  };
}

interface ExecuteOnePayoutArgs {
  agent: AgentDisbursement;
  companyPda: PublicKey;
  treasuryPda: PublicKey;
  policyPda: PublicKey;
  operationsPda: PublicKey;
  operator: ReturnType<typeof getOperatorKeypair>;
  connection: ReturnType<typeof getConnection>;
}

async function executeOnePayout(
  args: ExecuteOnePayoutArgs,
): Promise<PayoutResult> {
  const base = {
    deploymentId: args.agent.deploymentId,
    agentName: args.agent.agentName,
    invoiceIds: args.agent.invoiceIds,
    totalLamports: args.agent.totalLamports,
  };

  try {
    // Route to the native or SPL routine builder by the line's mint. SOL
    // lines pay native lamports; SPL lines (e.g. USDC) move tokens via the
    // treasury ATA, with the operator paying rent for any destination/fee
    // ATA created on demand. Both are signed by the operator as the
    // Disbursement Wallet signer.
    const isSol = args.agent.mint === SOL_PSEUDO_MINT.toBase58();
    const { instruction } = isSol
      ? buildDisburseRoutineInstruction({
          companyPda: args.companyPda,
          treasuryPda: args.treasuryPda,
          policyPda: args.policyPda,
          operationsPda: args.operationsPda,
          operationsSigner: args.operator.publicKey,
          deploymentPda: new PublicKey(args.agent.deploymentPda),
          destination: new PublicKey(args.agent.receivingAddress),
          amountLamports: BigInt(args.agent.totalLamports),
          mint: SOL_PSEUDO_MINT,
        })
      : buildDisburseRoutineSplInstruction({
          companyPda: args.companyPda,
          treasuryPda: args.treasuryPda,
          policyPda: args.policyPda,
          operationsPda: args.operationsPda,
          operationsSigner: args.operator.publicKey,
          deploymentPda: new PublicKey(args.agent.deploymentPda),
          destination: new PublicKey(args.agent.receivingAddress),
          amount: BigInt(args.agent.totalLamports),
          mint: new PublicKey(args.agent.mint),
        });

    const { blockhash, lastValidBlockHeight } =
      await args.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction();
    // Small priority bump — devnet routinely drops 0-priority txs under
    // load. Cheap to add, hugely improves landing reliability.
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    );
    tx.add(instruction);
    tx.recentBlockhash = blockhash;
    tx.feePayer = args.operator.publicKey;
    // Operator signs as both fee_payer AND operations_signer — the same
    // keypair fills both signature slots (Phase 1 simplification).
    tx.sign(args.operator);

    const raw = tx.serialize();
    const signature = await args.connection.sendRawTransaction(raw, {
      skipPreflight: true,
      preflightCommitment: "confirmed",
    });
    const confirm = await args.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    // `confirmTransaction` only throws on timeout (blockhash expired).
    // A tx that landed but reverted on-chain comes back with err != null.
    // Without this check we'd report success while the user's payout
    // actually failed — exactly the kind of silent fail that erodes
    // trust in autonomous payouts. Surface as a hard failure with the
    // chain error attached.
    if (confirm.value.err) {
      const chainErr = stringifyChainErr(confirm.value.err);
      log.error(
        { signature, chainErr, deploymentId: args.agent.deploymentId },
        "payout tx reverted on-chain",
      );
      return {
        ...base,
        signature,
        error: `On-chain revert: ${chainErr}`,
      };
    }

    return { ...base, signature, error: null };
  } catch (err) {
    // err can be a Solana SendTransactionError (object with InstructionError
    // field), a plain Error, or a string. `String({...})` returns
    // "[object Object]" which is useless in the UI — extract a real
    // message via stringifyChainErr first, then fall back to err.message.
    const inner = (err as { logs?: unknown; InstructionError?: unknown } | null)
      ?? null;
    const message =
      err instanceof Error
        ? err.message || stringifyChainErr(inner ?? err)
        : stringifyChainErr(err);
    log.error(
      { err, deploymentId: args.agent.deploymentId },
      "payout tx failed",
    );
    return { ...base, signature: null, error: message };
  }
}

// `confirmTransaction` returns a Solana `TransactionError`, which can be
// a string (rare) or an object like `{ InstructionError: [0, { Custom: 6014 }] }`.
// JSON-stringify so the FE / logs get something human-readable instead of
// "[object Object]".
function stringifyChainErr(err: unknown): string {
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown chain error";
  }
}
