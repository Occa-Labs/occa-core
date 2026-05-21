// Shared task-completion side-effects — the "done-path". Extracted from
// the task dispatcher so the auto-reviewer's approve verdict runs the
// exact same publish pipeline a clean dispatch would. Composes:
//   - autoSaveTaskAsDocument        — persist the deliverable as a document
//   - ensureInvoiceForCompletedTask — bill the company (idempotent)
//   - deliverTaskWebhooks           — POST to any matching company webhook
//   - recordEpisode                 — log a coverage episode (news_writer)
//   - cascadeOnTaskDone             — wake parents / unblock dependents
//
// Lives in features/tasks/services alongside the dispatcher; the
// same-feature imports of cascade are allowed. The billing import is a
// cross-feature reach that mirrors the dispatcher's existing (known,
// pre-existing) exception — kept identical so behaviour does not drift.

import { eq } from "drizzle-orm";
import { agentIdentities, deployments, tasks } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";
import { autoSaveTaskAsDocument } from "../../../services/auto-save-document";
import { deliverTaskWebhooks } from "../../../services/deliver-task-webhooks";
import { recordEpisode } from "../../../services/record-episode";
import { ensureInvoiceForCompletedTask } from "../../billing/services/invoice-on-task-complete";
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

  // Forward the deliverable to any company webhook whose filters match
  // (e.g. a research studio publishing to its own site). No-ops when the
  // company has registered none. Best-effort.
  void deliverTaskWebhooks({
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
  }).catch((err) => {
    log.error(
      { err, taskId: task.id },
      "deliverTaskWebhooks failed (non-fatal)",
    );
  });

  // Record an episode of the company's coverage — what stops a Head
  // repeating a topic. Scoped to the news writer: a settled news task is
  // one published story. Best-effort.
  if (agent.role === "news_writer") {
    void recordEpisode({
      companyId: task.companyId,
      taskId: task.id,
      title: task.title,
      content: input.deliverable,
      agent: { name: agent.name, role: agent.role },
      traceId: input.traceId,
      occurredAt,
    }).catch((err) => {
      log.error(
        { err, taskId: task.id },
        "recordEpisode failed (non-fatal)",
      );
    });
  }

  // Bubble up the task graph — unblock dependents, wake parents, and run
  // chat-origin synthesis where applicable.
  void cascadeOnTaskDone({ taskId: task.id }).catch((err) => {
    log.error({ err, taskId: task.id }, "cascadeOnTaskDone failed");
  });
}
