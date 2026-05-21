// Verification gate bridge. Runs the workflow verifier on a completing
// task's deliverable, records the verdict as a task event, and decides
// whether a failure should bounce back to the agent for another attempt
// or be parked for a human once the retry budget is spent. The
// dispatcher applies the returned action.
//
// Lives in `services/` (legacy spine) rather than under a feature
// because it bridges `features/tasks` (the dispatcher) and
// `features/workflows/verification` (the verifier) — CLAUDE.md forbids
// feature-to-feature imports, so the bridge sits outside both, mirroring
// `auto-save-document.ts`.

import { childLogger } from "../lib/logger";
import {
  appendTaskEventBestEffort,
  listTaskEvents,
} from "../features/tasks/services/events";
import { verifyStoryDocument } from "../features/workflows/verification/services/verifier";
import type { VerificationReport } from "../features/workflows/verification/domain/schemas";
import { roleRequiresVerification } from "../features/workflows/verification/domain/contract";
import { traceUsedDefillamaTool } from "../features/workflows/verification/repositories/trace-tool-usage";

const log = childLogger("services:verify-task-deliverable");

// Re-exported so the dispatcher keeps one import site for the gate
// bridge; the canonical definition lives in the verification domain's
// contract module, shared with the task-prompt renderer.
export { roleRequiresVerification };

// How many times a failed deliverable is bounced back to its agent
// before the gate gives up and parks the task for human review. The
// agent therefore gets MAX_VERIFICATION_BOUNCES + 1 total attempts.
const MAX_VERIFICATION_BOUNCES = 2;

// What the dispatcher should do with the deliverable.
//   accept — verification passed (or did not apply)
//   bounce — failed, retry budget left: re-dispatch to the agent
//   park   — failed, retry budget spent: hold in review for a human
export type GateAction = "accept" | "bounce" | "park";

export interface VerifyTaskDeliverableInput {
  companyId: string;
  taskId: string;
  traceId: string;
  cleanReply: string;
}

export interface GateVerdict {
  pass: boolean;
  action: GateAction;
  // Human-readable failure detail for the bounce comment. Null on pass.
  failureSummary: string | null;
}

async function countPriorVerificationFailures(
  taskId: string,
): Promise<number> {
  const events = await listTaskEvents(taskId);
  return events.filter(
    (e) =>
      (e.payload as Record<string, unknown> | null)?.actionType ===
      "VerificationFailed",
  ).length;
}

function buildFailureSummary(
  report: VerificationReport,
  attempt: number,
  totalAttempts: number,
): string {
  const lines: string[] = [
    `Automated verification failed on your last submission — it was ` +
      `not accepted (attempt ${attempt} of ${totalAttempts}).`,
  ];
  if (report.dateError) lines.push(`- ${report.dateError}`);
  for (const r of report.results) {
    if (r.status === "ok") continue;
    lines.push(`- ${r.label}: ${r.detail ?? r.status}`);
  }
  lines.push(
    `Fix: emit the <!--occa:claims--> block exactly as the VERIFIED ` +
      `CLAIMS section of this prompt specifies, copy every number ` +
      `verbatim from your tool results, then resubmit.`,
  );
  return lines.join("\n");
}

// Bounce feedback for the missing-block leak: the run called the
// DefiLlama tools but the deliverable shipped no claims block.
function buildMissingBlockSummary(
  attempt: number,
  totalAttempts: number,
): string {
  return [
    `Automated verification held back your last submission — it was ` +
      `not accepted (attempt ${attempt} of ${totalAttempts}).`,
    `- This task's run called the DefiLlama data tools, but your ` +
      `deliverable shipped no <!--occa:claims--> block. Every on-chain ` +
      `number you used must be declared in that block so the gate can ` +
      `verify it.`,
    `Fix: add the <!--occa:claims--> block exactly as the VERIFIED ` +
      `CLAIMS section of this prompt specifies, with one row per ` +
      `DefiLlama figure in your story, then resubmit. If your story ` +
      `genuinely has no on-chain numbers, do not call the DefiLlama ` +
      `tools at all.`,
  ].join("\n");
}

// Verifies a deliverable, records the outcome as a task event, and
// returns the action the dispatcher should take. Never throws: an
// unexpected internal fault fails OPEN (logged) so a bug in the gate
// cannot wedge every news task. A genuine "source unreachable" is not a
// fault — the verifier surfaces it as failed claims, which fails CLOSED,
// which is correct.
export async function verifyTaskDeliverable(
  input: VerifyTaskDeliverableInput,
): Promise<GateVerdict> {
  let report: VerificationReport;
  try {
    report = await verifyStoryDocument(input.cleanReply);
  } catch (err) {
    log.error(
      { err, taskId: input.taskId },
      "verification gate crashed; failing open",
    );
    return { pass: true, action: "accept", failureSummary: null };
  }

  // A deliverable can fail the gate two ways:
  //   - the verifier rejected it (a number mismatched, a block was
  //     malformed, or the retrieval date was in the future);
  //   - it shipped no claims block at all, yet the run actually called
  //     the DefiLlama tools — on-chain numbers that escaped the gate.
  const verifierFailed = !report.pass;
  const missingBlockLeak =
    report.pass &&
    !report.claimsBlockPresent &&
    (await traceUsedDefillamaTool(input.traceId));

  if (!verifierFailed && !missingBlockLeak) {
    log.info(
      {
        taskId: input.taskId,
        claims: report.results.length,
        claimsBlockPresent: report.claimsBlockPresent,
      },
      "deliverable passed verification gate",
    );
    return { pass: true, action: "accept", failureSummary: null };
  }

  const priorFailures = await countPriorVerificationFailures(input.taskId);
  const attempt = priorFailures + 1;
  const totalAttempts = MAX_VERIFICATION_BOUNCES + 1;
  const action: GateAction =
    attempt <= MAX_VERIFICATION_BOUNCES ? "bounce" : "park";

  const failures = report.results.filter((r) => r.status !== "ok");
  const reason = missingBlockLeak ? "missing_claims_block" : "claim_mismatch";
  log.warn(
    {
      taskId: input.taskId,
      reason,
      dateError: report.dateError,
      failures: failures.length,
      attempt,
      action,
    },
    "deliverable failed verification gate",
  );

  // Awaited (not fire-and-forget) so the attempt count is reliable for
  // the next round's bounce-vs-park decision.
  await appendTaskEventBestEffort({
    companyId: input.companyId,
    taskId: input.taskId,
    eventType: "agent_action_emitted",
    actorType: "system",
    actorId: "system",
    payload: {
      actionType: "VerificationFailed",
      channel: "http",
      reason,
      outcome: action,
      attempt,
      asOf: report.asOf,
      dateError: report.dateError,
      failures: failures.map((r) => ({
        id: r.id,
        label: r.label,
        status: r.status,
        claimed: r.claimed,
        observed: r.observed,
        detail: r.detail,
      })),
    },
    traceId: input.traceId,
  });

  return {
    pass: false,
    action,
    failureSummary: missingBlockLeak
      ? buildMissingBlockSummary(attempt, totalAttempts)
      : buildFailureSummary(report, attempt, totalAttempts),
  };
}
