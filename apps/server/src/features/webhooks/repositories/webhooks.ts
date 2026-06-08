// Company webhooks repository — the only place Drizzle touches the
// `company_webhooks` table.

import { and, desc, eq } from "drizzle-orm";
import { companyWebhooks } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type CompanyWebhookRow = typeof companyWebhooks.$inferSelect;

// ── Operator CRUD ─────────────────────────────────────────────────────
// Management surface for the Settings UI. Newest first.

export async function listByCompany(
  companyId: string,
): Promise<CompanyWebhookRow[]> {
  return db
    .select()
    .from(companyWebhooks)
    .where(eq(companyWebhooks.companyId, companyId))
    .orderBy(desc(companyWebhooks.createdAt));
}

// Scoped by company so a user can't read another company's webhook by
// guessing its id.
export async function findByIdForCompany(args: {
  id: string;
  companyId: string;
}): Promise<CompanyWebhookRow | null> {
  const [row] = await db
    .select()
    .from(companyWebhooks)
    .where(
      and(
        eq(companyWebhooks.id, args.id),
        eq(companyWebhooks.companyId, args.companyId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function create(args: {
  companyId: string;
  name: string;
  targetUrl: string;
  secret: string;
  enabled: boolean;
}): Promise<CompanyWebhookRow> {
  const [row] = await db
    .insert(companyWebhooks)
    .values({
      companyId: args.companyId,
      name: args.name,
      targetUrl: args.targetUrl,
      secret: args.secret,
      enabled: args.enabled,
    })
    .returning();
  return row!;
}

export async function updateById(args: {
  id: string;
  patch: {
    name?: string;
    targetUrl?: string;
    secret?: string;
    enabled?: boolean;
  };
}): Promise<CompanyWebhookRow> {
  const [row] = await db
    .update(companyWebhooks)
    .set({ ...args.patch, updatedAt: new Date() })
    .where(eq(companyWebhooks.id, args.id))
    .returning();
  return row!;
}

export async function deleteById(id: string): Promise<void> {
  await db.delete(companyWebhooks).where(eq(companyWebhooks.id, id));
}

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
