#!/usr/bin/env tsx
// Seeds (or updates) the Glyph company's outbound webhook so completed
// news tasks are forwarded to the crypoch publish API.
//
// This is config, not OCCA core logic — OCCA stays generic; this row is
// what makes one specific company (Glyph) publish to one specific
// surface (crypoch). Other companies seed their own webhooks the same
// way, or via a future UI.
//
// Idempotent: matches an existing webhook by (companyId, name) and
// updates it; otherwise inserts.
//
// Usage (from apps/server/):
//
//   CRYPOCH_PUBLISH_URL=https://occa.team/api/publish \
//   CRYPOCH_PUBLISH_TOKEN=<shared-secret> \
//   pnpm exec tsx --env-file=../../.env scripts/seed-glyph-webhook.ts

import { and, eq } from "drizzle-orm";
import { companies, companyWebhooks } from "@occa/shared/schema";
import { db, pool } from "../src/infra/database/client";

const WEBHOOK_NAME = "crypoch publish";
const COMPANY_NAME = process.env.GLYPH_COMPANY_NAME ?? "Glyph";
const TARGET_URL =
  process.env.CRYPOCH_PUBLISH_URL ?? "http://localhost:3000/api/publish";
const SECRET = process.env.CRYPOCH_PUBLISH_TOKEN;
// Only news-writer deliverables go to crypoch; the receiver maps role to
// section. Widen this when more roles publish.
const FILTER_ROLES = ["news_writer"];

async function main(): Promise<void> {
  if (!SECRET) {
    console.error(
      "CRYPOCH_PUBLISH_TOKEN is required (the HMAC shared secret).",
    );
    process.exit(1);
  }

  const [company] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.name, COMPANY_NAME))
    .limit(1);

  if (!company) {
    const all = await db
      .select({ name: companies.name })
      .from(companies);
    console.error(
      `No company named "${COMPANY_NAME}". Set GLYPH_COMPANY_NAME to ` +
        `one of: ${all.map((c) => c.name).join(", ") || "(none)"}`,
    );
    process.exit(1);
  }

  const [existing] = await db
    .select({ id: companyWebhooks.id })
    .from(companyWebhooks)
    .where(
      and(
        eq(companyWebhooks.companyId, company.id),
        eq(companyWebhooks.name, WEBHOOK_NAME),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(companyWebhooks)
      .set({
        targetUrl: TARGET_URL,
        secret: SECRET,
        filterRoles: FILTER_ROLES,
        enabled: true,
        updatedAt: new Date(),
      })
      .where(eq(companyWebhooks.id, existing.id));
    console.log(`Updated webhook ${existing.id} → ${TARGET_URL}`);
  } else {
    const [row] = await db
      .insert(companyWebhooks)
      .values({
        companyId: company.id,
        name: WEBHOOK_NAME,
        targetUrl: TARGET_URL,
        secret: SECRET,
        event: "task.completed",
        filterRoles: FILTER_ROLES,
        enabled: true,
      })
      .returning({ id: companyWebhooks.id });
    console.log(`Created webhook ${row.id} → ${TARGET_URL}`);
  }
}

void main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
