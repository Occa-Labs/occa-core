#!/usr/bin/env tsx
// One-shot backfill — for every `pending` approval that doesn't yet have
// a corresponding `approval_pending` notification, emit one so the new
// notifications inbox shows the same backlog the legacy "NotificationCenter
// reads approvals directly" UI used to show.
//
// Usage (from apps/server/):
//
//   pnpm tsx scripts/backfill-approval-notifications.ts                # dry run
//   CONFIRM=1 pnpm tsx scripts/backfill-approval-notifications.ts      # apply
//
// Idempotent — skips approvals where a notification already references
// the same approvalId in payload.

import { eq, sql } from "drizzle-orm";
import { db } from "../src/infra/database/client";
import { approvals, companies, notifications } from "@occa/shared/schema";
import { notifyApprovalCreated } from "../src/features/approvals/services/post-create";

async function main(): Promise<void> {
  const confirm = process.env.CONFIRM === "1";

  const pending = await db
    .select()
    .from(approvals)
    .where(eq(approvals.status, "pending"));

  console.log(`Found ${pending.length} pending approval(s).`);

  let emitted = 0;
  let skipped = 0;
  let missingOwner = 0;

  for (const row of pending) {
    // Idempotency check — payload->>'approvalId' matches.
    const [existing] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(sql`${notifications.payload}->>'approvalId' = ${row.id}`)
      .limit(1);
    if (existing) {
      skipped += 1;
      continue;
    }

    const [company] = await db
      .select({ ownerUserId: companies.ownerUserId })
      .from(companies)
      .where(eq(companies.id, row.companyId))
      .limit(1);
    if (!company?.ownerUserId) {
      missingOwner += 1;
      console.log(`  ! ${row.id} — company ${row.companyId} has no owner; skip`);
      continue;
    }

    if (!confirm) {
      console.log(
        `  - dry-run: would emit notif for approval ${row.id} (kind=${row.actionType}) to user ${company.ownerUserId}`,
      );
      emitted += 1;
      continue;
    }

    await notifyApprovalCreated(row);
    emitted += 1;
    console.log(`  ✓ emitted for approval ${row.id}`);
  }

  console.log(
    `Done. emitted=${emitted} skipped=${skipped} missingOwner=${missingOwner} confirm=${confirm}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
