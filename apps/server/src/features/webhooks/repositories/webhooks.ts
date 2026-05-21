// Company webhooks repository — the only place Drizzle touches the
// `company_webhooks` table.

import { and, eq } from "drizzle-orm";
import { companyWebhooks } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type CompanyWebhookRow = typeof companyWebhooks.$inferSelect;

// Enabled webhooks a company has registered for one event. Filter
// matching is applied by the caller (domain logic), not in SQL.
export async function listEnabledWebhooks(args: {
  companyId: string;
  event: string;
}): Promise<CompanyWebhookRow[]> {
  return db
    .select()
    .from(companyWebhooks)
    .where(
      and(
        eq(companyWebhooks.companyId, args.companyId),
        eq(companyWebhooks.event, args.event),
        eq(companyWebhooks.enabled, true),
      ),
    );
}

// Best-effort delivery diagnostics. Updated after every attempt so an
// operator can see when a webhook last fired and why it last failed.
export async function recordWebhookDelivery(args: {
  webhookId: string;
  status: string;
  error: string | null;
}): Promise<void> {
  await db
    .update(companyWebhooks)
    .set({
      lastDeliveredAt: new Date(),
      lastStatus: args.status,
      lastError: args.error,
      updatedAt: new Date(),
    })
    .where(eq(companyWebhooks.id, args.webhookId));
}
