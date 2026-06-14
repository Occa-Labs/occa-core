// Shared task-completion side-effects — the "done-path". Extracted from
// the task dispatcher so the auto-reviewer's approve verdict runs the
// exact same publish pipeline a clean dispatch would. Composes:
//   - autoSaveTaskAsDocument        — persist the deliverable as a document
//   - ensureInvoiceForCompletedTask — bill the company (idempotent)
//   - deliverTaskWebhooks           — POST to any matching company webhook
//   - commit_trace anchor           — on-chain provenance for opted-in companies
//   - cascadeOnTaskDone             — wake parents / unblock dependents
//
// Lives in features/tasks/services alongside the dispatcher; the
// same-feature imports of cascade are allowed. The billing import is a
// cross-feature reach that mirrors the dispatcher's existing (known,
// pre-existing) exception — kept identical so behaviour does not drift.

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentIdentities, deployments, tasks } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";
import { autoSaveTaskAsDocument } from "../../../services/auto-save-document";
import { deliverTaskWebhooks } from "../../../services/deliver-task-webhooks";
import { ensureInvoiceForCompletedTask } from "../../billing/services/invoice-on-task-complete";
// Cross-feature reach into the chain feature — mirrors the pre-existing
// billing exception above. The on-chain anchor is a done-path side-effect
// like the others; the engine self-gates (company not opted into
// anchoring → no-op), so this stays best-effort.
import { commitTraceForTask } from "../../chain/services/commit-trace-engine";
import { cascadeOnTaskDone } from "./cascade";
import { appendTaskEventBestEffort } from "./events";

const log = childLogger("services:tasks:finalize");

export interface FinalizeTaskDoneInput {
  taskId: string;
  // The agent's clean deliverable text (OCCA markers already stripped).
  deliverable: string;
  // Trace that produced the deliverable — stamped on the episode and
  // webhook audit so they link back to the run that wrote the content.
  traceId: string;
  // When the deliverable settled. Defaults to now.
  occurredAt?: Date;
}

// Runs the full task-completion pipeline for a task settling to `done`.
// Idempotent on status — it only flips the row + emits a status event
// when the task is not already `done`, so it is safe to call from both
// the dispatcher's own done-path (task already `done`) and the
// auto-reviewer's approve verdict (task still parked in `review`).
export async function finalizeTaskDone(
  input: FinalizeTaskDoneInput,
): Promise<void> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1);
  if (!task || !task.assignedDeploymentId) {
    log.warn(
      { taskId: input.taskId },
      "finalizeTaskDone: task missing or unassigned",
    );
    return;
  }
  const [agent] = await db
    .select({
      id: deployments.id,
      role: deployments.role,
      name: agentIdentities.name,
    })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(eq(deployments.id, task.assignedDeploymentId))
    .limit(1);
  if (!agent) {
    log.warn(
      { taskId: input.taskId },
      "finalizeTaskDone: assignee deployment missing",
    );
    return;
  }

  // Editor of record — the agent that delegated the task. Surfaced in the
  // webhook payload so a publishing receiver can credit it. Skipped when
  // the task had no delegator, or delegated to itself.
  let editor: { name: string; role: string } | null = null;
  if (
    task.createdByDeploymentId &&
    task.createdByDeploymentId !== task.assignedDeploymentId
  ) {
    const [row] = await db
      .select({ role: deployments.role, name: agentIdentities.name })
      .from(deployments)
      .innerJoin(
        agentIdentities,
        eq(deployments.agentIdentityId, agentIdentities.id),
      )
      .where(eq(deployments.id, task.createdByDeploymentId))
      .limit(1);
    if (row) editor = { name: row.name, role: row.role };
  }

  const occurredAt = input.occurredAt ?? new Date();

  // Flip to `done` when the task is not there yet (the auto-reviewer's
  // approve path: the task is still parked in `review`). The dispatcher's
  // own done-path already set `done`, so this is a no-op for it.
  if (task.status !== "done") {
    await db
      .update(tasks)
      .set({ status: "done", linkedTraceId: null, updatedAt: occurredAt })
      .where(eq(tasks.id, task.id));
    void appendTaskEventBestEffort({
      companyId: task.companyId,
      taskId: task.id,
      eventType: "task_status_changed",
      actorType: "system",
      actorId: "system",
      payload: { from: task.status, to: "done", reason: "review_approved" },
      traceId: input.traceId,
    });
  }

  void autoSaveTaskAsDocument({
    taskId: task.id,
    deploymentId: agent.id,
    cleanReply: input.deliverable,
  }).catch((err) => {
    log.error(
      { err, taskId: task.id },
      "autoSaveTaskAsDocument failed (non-fatal)",
    );
  });

  // Phase 1b-ii: bill the company for the completed task. No-ops when the
  // agent has no task rate set. Idempotent — safe to fire-and-forget.
  void ensureInvoiceForCompletedTask({ taskId: task.id }).catch((err) => {
    log.error(
      { err, taskId: task.id },
      "ensureInvoiceForCompletedTask failed (non-fatal)",
    );
  });

  // Publish + on-chain provenance, as one detached flow. First forward the
  // deliverable to any matching company webhook (e.g. a studio publishing
  // to its own site); then anchor the verified deliverable via
  // commit_trace. Detached + best-effort so task completion never blocks on
  // the webhook round-trip or RPC.
  //
  // The anchor's result_uri is the URL the publish receiver returns (e.g.
  // crypoch's live article URL), so the on-chain record links straight to
  // the published artifact. Empty when nothing was published (private work).
  //
  // Anchors every completed deliverable for companies opted into anchoring;
  // the engine no-ops when the company has no healthy Anchor
  // OperationsAccount. Evidence is the sha256 of the deliverable itself —
  // domain-neutral, independent of any company-specific verification. A
  // company that wants graded quality plugs in its own rubric later.
  void (async () => {
    // The on-chain result_uri comes from the task's own `resultUri` field —
    // set by the agent after it publishes (via a tool) or manually by the
    // operator. The legacy webhook delivery is kept only as a fallback for
    // companies still on that path; it no longer drives anchoring.
    let resultUri = task.resultUri ?? "";
    if (!resultUri) {
      try {
        const delivery = await deliverTaskWebhooks({
          companyId: task.companyId,
          task: {
            id: task.id,
            title: task.title,
            tags: task.tags,
            taskType: task.taskType,
          },
          agent: { name: agent.name, role: agent.role },
          editor,
          document: {
            content: input.deliverable,
            format: "markdown",
            tags: task.tags,
          },
          traceId: input.traceId,
        });
        resultUri = delivery.resultUri ?? "";
      } catch (err) {
        log.error(
          { err, taskId: task.id },
          "deliverTaskWebhooks failed (non-fatal)",
        );
      }
    }

    try {
      const evidenceHashHex = createHash("sha256")
        .update(input.deliverable, "utf8")
        .digest("hex");
      const result = await commitTraceForTask({
        companyId: task.companyId,
        taskId: task.id,
        deploymentId: agent.id,
        deliverable: input.deliverable,
        resultUri,
        evidenceHashHex,
        qualityScore: 100,
        rubricVersion: 1,
        completedAt: Math.floor(occurredAt.getTime() / 1000),
      });
      if (result.status === "failed") {
        log.error(
          { taskId: task.id, error: result.error },
          "commit_trace anchor failed",
        );
      } else {
        log.info(
          {
            taskId: task.id,
            status: result.status,
            traceAnchorPda: result.traceAnchorPda,
            resultUri: resultUri || null,
          },
          "commit_trace anchor outcome",
        );
      }
    } catch (err) {
      log.error(
        { err, taskId: task.id },
        "anchor verified deliverable failed (non-fatal)",
      );
    }
  })();

  // Bubble up the task graph — unblock dependents, wake parents, and run
  // chat-origin synthesis where applicable.
  void cascadeOnTaskDone({ taskId: task.id }).catch((err) => {
    log.error({ err, taskId: task.id }, "cascadeOnTaskDone failed");
  });
}
