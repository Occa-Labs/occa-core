// Row → DTO projection for company webhooks. The secret is write-only: it
// never crosses the API boundary. `hasSecret` is all the client learns.

import type { WebhookDTO } from "@occa/shared/types";
import type { CompanyWebhookRow } from "../repositories/webhooks";

export function toWebhookDTO(row: CompanyWebhookRow): WebhookDTO {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    targetUrl: row.targetUrl,
    event: row.event,
    enabled: row.enabled,
    hasSecret: row.secret.length > 0,
    lastDeliveredAt: row.lastDeliveredAt
      ? row.lastDeliveredAt.toISOString()
      : null,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    lastResponse: row.lastResponse,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
