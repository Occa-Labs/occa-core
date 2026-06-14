#!/usr/bin/env tsx
// Manually fire a sample treasury_readiness notification through the
// normal `emitNotification` path. Exercises the channel fan-out
// (Telegram push, future Discord/Slack) end-to-end without waiting for
// the hourly cron or simulating a real payable invoice.
//
// Usage (from apps/server/):
//
//   pnpm exec tsx --env-file=../../.env scripts/trigger-disbursement-notif.ts
//
// Picks the first active user-kind company + its CEO deployment. If you
// have multiple companies, pass the deployment id as arg 1:
//
//   pnpm exec tsx --env-file=../../.env scripts/trigger-disbursement-notif.ts <deploymentId>

import { and, eq, isNull } from "drizzle-orm";
import { companies, deployments } from "@occa/shared/schema";
import { CEO_ROLE } from "@occa/shared/role-catalog";
import { db, pool } from "../src/infra/database/client";
import { emitNotification } from "../src/features/notifications/services/emit";

async function resolveTarget(argDeploymentId: string | undefined): Promise<{
  companyId: string;
  ownerUserId: string;
  deploymentName: string;
} | null> {
  if (argDeploymentId) {
    const [row] = await db
      .select({
        companyId: deployments.companyId,
        ownerUserId: companies.ownerUserId,
        deploymentRole: deployments.role,
      })
      .from(deployments)
      .innerJoin(companies, eq(companies.id, deployments.companyId))
      .where(eq(deployments.id, argDeploymentId))
      .limit(1);
    if (!row || !row.ownerUserId) return null;
    return {
      companyId: row.companyId,
      ownerUserId: row.ownerUserId,
      deploymentName: argDeploymentId,
    };
  }

  // First active user-kind company → its CEO deployment.
  const [row] = await db
    .select({
      companyId: companies.id,
      ownerUserId: companies.ownerUserId,
      deploymentId: deployments.id,
    })
    .from(companies)
    .innerJoin(deployments, eq(deployments.companyId, companies.id))
    .where(
      and(
        eq(companies.kind, "user"),
        isNull(companies.deletedAt),
        isNull(companies.pausedAt),
        eq(deployments.role, CEO_ROLE),
        eq(deployments.status, "active"),
      ),
    )
    .limit(1);
  if (!row || !row.ownerUserId) return null;
  return {
    companyId: row.companyId,
    ownerUserId: row.ownerUserId,
    deploymentName: row.deploymentId,
  };
}

async function main(): Promise<void> {
  const argId = process.argv[2];
  const target = await resolveTarget(argId);
  if (!target) {
    console.error("No active CEO deployment found.");
    process.exit(1);
  }

  console.log(
    `firing treasury_readiness for company=${target.companyId} (CEO deployment=${target.deploymentName})`,
  );
  const row = await emitNotification({
    companyId: target.companyId,
    userId: target.ownerUserId,
    kind: "treasury_readiness",
    title: "Disbursement ready — 3 agents due",
    body: "0.1250 SOL across 3 agents pending. Open Treasury and run disbursement.",
    payload: { simulated: true },
    link: "chain:treasury",
  });
  console.log(`emitted notification ${row.id}`);
  // Give the fire-and-forget channel fan-out a moment to settle before
  // the script exits and tears down the pool.
  await new Promise((r) => setTimeout(r, 1500));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
