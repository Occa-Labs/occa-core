// Manual test delivery. Builds a clearly-marked synthetic payload and fires
// it through the normal delivery path, so the same signing, timeout, and
// health-recording apply. The payload is flagged as a test in its content so
// a receiver can choose to ignore it — but a publish endpoint may still act
// on it, so this is a real outbound request, not a dry run.

import {
  deliverWebhook,
  type DeliveryResult,
} from "./deliver";
import { WEBHOOK_EVENT_TASK_COMPLETED } from "../domain/types";
import type { CompanyWebhookRow } from "../repositories/webhooks";

export async function sendTestDelivery(args: {
  webhook: CompanyWebhookRow;
  company: { id: string; name: string };
}): Promise<DeliveryResult> {
  return deliverWebhook(args.webhook, {
    event: WEBHOOK_EVENT_TASK_COMPLETED,
    occurredAt: new Date().toISOString(),
    company: { id: args.company.id, name: args.company.name },
    task: {
      id: "test",
      title: "OCCA webhook test",
      tags: ["test"],
      taskType: "test",
    },
    document: {
      title: "OCCA webhook test",
      content:
        "This is a test delivery from OCCA. No task was completed — it confirms the endpoint is reachable and the signature verifies.",
      format: "markdown",
      tags: ["test"],
    },
    agent: { name: "OCCA", role: "system" },
    delegatedBy: null,
    trace: { id: "test" },
  });
}
