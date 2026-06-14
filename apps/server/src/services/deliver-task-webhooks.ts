// Outbound webhook bridge. Once a task settles into `done`, this
// forwards the deliverable to every enabled company webhook whose
// filters match the task. The dispatcher calls it best-effort — a
// delivery failure must never block the dispatch close-out.
//
// Lives in `services/` (legacy spine) rather than under a feature
// because it bridges `features/tasks` (the dispatcher + task events)
// and `features/webhooks` — CLAUDE.md forbids feature-to-feature
// imports, so the bridge sits outside both, mirroring
// `auto-save-document.ts`.

import { eq } from "drizzle-orm";
import { companies } from "@occa/shared/schema";
import { db } from "../infra/database/client";
import { childLogger } from "../lib/logger";
import { listEnabledWebhooks } from "../features/webhooks/repositories/webhooks";
import { deliverWebhook } from "../features/webhooks/services/deliver";
import {
  WEBHOOK_EVENT_TASK_COMPLETED,
  webhookMatchesTask,
  type TaskCompletedPayload,
} from "../features/webhooks/domain/types";
import { appendTaskEventBestEffort } from "../features/tasks/services/events";

const log = childLogger("services:deliver-task-webhooks");

export interface DeliverTaskWebhooksInput {
  companyId: string;
  task: { id: string; title: string; tags: string[]; taskType: string };
  agent: { name: string; role: string };
  /** The editor agent of record. Null when the task had no delegator. */
  editor: { name: string; role: string } | null;
  /** The clean, markers-stripped agent deliverable. */
  document: { content: string; format: string; tags: string[] };
  traceId: string;
}

export interface DeliverTaskWebhooksResult {
  /** Canonical URL returned by the first webhook receiver that provided
   *  one (e.g. a published article URL). Null when nothing published or
   *  no receiver returned a URL. Used to populate on-chain result_uri. */
  resultUri: string | null;
}

export async function deliverTaskWebhooks(
  input: DeliverTaskWebhooksInput,
): Promise<DeliverTaskWebhooksResult> {
  const webhooks = await listEnabledWebhooks({
    companyId: input.companyId,
    event: WEBHOOK_EVENT_TASK_COMPLETED,
  });
  if (webhooks.length === 0) return { resultUri: null };

  const matching = webhooks.filter((w) =>
    webhookMatchesTask(
      {
        roles: w.filterRoles,
        tags: w.filterTags,
        taskTypes: w.filterTaskTypes,
      },
      {
        role: input.agent.role,
        tags: input.task.tags,
        taskType: input.task.taskType,
      },
    ),
  );
  if (matching.length === 0) return { resultUri: null };

  const [companyRow] = await db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1);

  const payload: TaskCompletedPayload = {
    event: WEBHOOK_EVENT_TASK_COMPLETED,
    occurredAt: new Date().toISOString(),
    company: { id: input.companyId, name: companyRow?.name ?? "" },
    task: {
      id: input.task.id,
      title: input.task.title,
      tags: input.task.tags,
      taskType: input.task.taskType,
    },
    document: {
      title: input.task.title,
      content: input.document.content,
      format: input.document.format,
      tags: input.document.tags,
    },
    agent: { name: input.agent.name, role: input.agent.role },
    editor: input.editor,
    trace: { id: input.traceId },
  };

  let resultUri: string | null = null;
  for (const webhook of matching) {
    const result = await deliverWebhook(webhook, payload);
    // First receiver-returned URL wins (one publish target per company in
    // practice). Used to link the on-chain trace to the published artifact.
    if (!resultUri && result.resultUri) resultUri = result.resultUri;
    // Record on the task timeline for traceability — which webhook
    // received this deliverable, and whether the receiver accepted it.
    await appendTaskEventBestEffort({
      companyId: input.companyId,
      taskId: input.task.id,
      eventType: "agent_action_emitted",
      actorType: "system",
      actorId: "system",
      payload: {
        actionType: "WebhookDelivered",
        channel: "http",
        webhookId: webhook.id,
        webhookName: webhook.name,
        outcome: result.ok ? "ok" : "failed",
        status: result.status,
        url: result.resultUri,
      },
      traceId: input.traceId,
    });
  }

  log.info(
    {
      companyId: input.companyId,
      taskId: input.task.id,
      delivered: matching.length,
    },
    "task webhooks dispatched",
  );

  return { resultUri };
}
