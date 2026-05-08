#!/usr/bin/env tsx
// One-shot cleanup for `pending` approval rows with action_type='hire'
// left over from the agent-can-hire-agent feature removed on 2026-05-09.
//
// The hire path is gone end-to-end (handlers, schemas, side-effects), but
// any pre-existing `pending` rows still surface in the notification list
// with a stale "Wants to hire" subtitle. Approving such a row is now a
// silent no-op (no side effect runs) — better to mark them cancelled so
// the audit trail tells the story and the UI list stops showing them.
//
// Usage (from apps/server/):
//
//   pnpm cancel-legacy-hire-approvals             # dry run (default)
//   CONFIRM=1 pnpm cancel-legacy-hire-approvals   # apply
//
// Idempotent — running twice does nothing on the second pass because the
// WHERE clause filters on status='pending'.

import { and, eq } from "drizzle-orm";
import { db } from "../src/infra/database/client";
import { approvals } from "@occa/shared/schema";

const CANCEL_REASON = "feature_removed_2026_05_09:agent_to_agent_hire";

async function main(): Promise<void> {
  const confirm = process.env.CONFIRM === "1";

  const pending = await db
    .select({
      id: approvals.id,
      companyId: approvals.companyId,
      requestedAt: approvals.requestedAt,
    })
    .from(approvals)
    .where(and(eq(approvals.actionType, "hire"), eq(approvals.status, "pending")));

  console.log(`Found ${pending.length} pending hire approval(s).`);
  for (const row of pending) {
    console.log(
      `  - ${row.id} (company=${row.companyId}, requested=${row.requestedAt.toISOString()})`,
    );
  }

  if (pending.length === 0) {
    console.log("Nothing to cancel.");
    return;
  }

  if (!confirm) {
    console.log("\nDry run — set CONFIRM=1 to apply.");
    return;
  }

  const now = new Date();
  const result = await db
    .update(approvals)
    .set({
      status: "cancelled",
      decidedAt: now,
      rejectionReason: CANCEL_REASON,
      updatedAt: now,
    })
    .where(and(eq(approvals.actionType, "hire"), eq(approvals.status, "pending")))
    .returning({ id: approvals.id });

  console.log(`\nCancelled ${result.length} approval row(s).`);
}

void main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
