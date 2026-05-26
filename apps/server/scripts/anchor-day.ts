#!/usr/bin/env tsx
// Manually commit a daily anchor for one UTC day. Bypasses the hourly
// cron's "yesterday only" rule — useful for testing the anchor flow
// without waiting for midnight UTC.
//
// The on-chain ix `commit_daily_anchor` validates `day_unix <= now`, so
// you can anchor today pre-midnight. Same on-chain idempotency applies:
// re-running for an already-anchored day no-ops.
//
// Server does NOT need to be running — this calls into the engine
// directly. Operator keypair must be configured via env (OPERATOR_*).
//
// Usage (from apps/server/):
//
//   pnpm exec tsx --env-file=../../.env scripts/anchor-day.ts [YYYY-MM-DD]
//
// No date arg → anchors today's UTC start.

import { pool } from "../src/infra/database/client";
import {
  runDailyAnchor,
  SECONDS_PER_DAY,
  startOfUtcDay,
} from "../src/features/chain/services/daily-anchor-engine";

async function main(): Promise<void> {
  const dateArg = process.argv[2];
  let dayUnix: number;
  if (dateArg) {
    const ms = Date.parse(`${dateArg}T00:00:00Z`);
    if (!Number.isFinite(ms)) {
      console.error(`invalid date: ${dateArg} (expected YYYY-MM-DD)`);
      process.exit(1);
    }
    dayUnix = Math.floor(ms / 1000);
    if (dayUnix % SECONDS_PER_DAY !== 0) {
      console.error(`day_unix ${dayUnix} not aligned to UTC midnight`);
      process.exit(1);
    }
  } else {
    dayUnix = startOfUtcDay(Math.floor(Date.now() / 1000));
  }

  console.log(
    `anchoring day_unix=${dayUnix} (${new Date(
      dayUnix * 1000,
    ).toISOString()})`,
  );

  const summary = await runDailyAnchor(dayUnix);
  console.log(JSON.stringify(summary, null, 2));

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
