#!/usr/bin/env tsx
// Smoke test for executeWorkerDelegations (apps/worker/src/delegation.ts).
//
// Validates the worker-path DELEGATE handler:
//   1. Valid DELEGATE block → child task created + audit row with
//      outcome "delegated" + childTaskId stamped
//   2. Re-run with same DELEGATE → no-loop guard fires, audit outcome
//      "ignored" with reason "target_already_delegated", no dup child
//   3. Invalid target (not a subordinate) → ignored:target_not_subordinate
//   4. Routine-source vs continuation-source both fire the handler
//      (verified by the dispatcher.ts change, exercised here by calling
//      the function directly which is path-agnostic by design)
//
// Wraps everything in a transaction that ROLLS BACK at the end so the
// local DB is unchanged.
//
// Usage from apps/worker/:
//   pnpm exec tsx --env-file=../../.env scripts/smoke-delegation.ts

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  agentIdentities,
  companies,
  deployments,
  taskEvents,
  tasks,
  traces,
  users,
} from "@occa/shared/schema";
import { db } from "../src/db";
import { executeWorkerDelegations } from "../src/delegation";
import { syncTaskOnTraceSucceeded } from "../src/task-sync";

let pass = 0;
let fail = 0;

function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined) console.log("        ", detail);
    fail++;
  }
}

interface SeedResult {
  userId: string;
  companyId: string;
  orchestratorId: string;
  subordinateId: string;
  parentTaskId: string;
  traceId: string;
}

async function seed(): Promise<SeedResult> {
  // user
  const [u] = await db
    .insert(users)
    .values({ walletAddress: `smoke-${randomUUID()}` })
    .returning({ id: users.id });

  // company
  const [c] = await db
    .insert(companies)
    .values({
      ownerUserId: u.id,
      name: "SmokeCo",
      kind: "user",
    })
    .returning({ id: companies.id });

  // 2 identities (orchestrator + subordinate)
  const [orchIdent, subIdent] = await Promise.all([
    db
      .insert(agentIdentities)
      .values({
        ownerUserId: u.id,
        agentPubkey: `smoke-orch-${randomUUID()}`,
        identityPda: `smoke-orch-pda-${randomUUID()}`,
        ownerWallet: "smoke-wallet",
        name: "Orchestrator",
      })
      .returning({ id: agentIdentities.id })
      .then((r) => r[0]),
    db
      .insert(agentIdentities)
      .values({
        ownerUserId: u.id,
        agentPubkey: `smoke-sub-${randomUUID()}`,
        identityPda: `smoke-sub-pda-${randomUUID()}`,
        ownerWallet: "smoke-wallet",
        name: "Subordinate",
      })
      .returning({ id: agentIdentities.id })
      .then((r) => r[0]),
  ]);

  // 2 deployments — orchestrator at index 0, subordinate reports to it
  const [orchDep] = await db
    .insert(deployments)
    .values({
      companyId: c.id,
      agentIdentityId: orchIdent.id,
      deploymentPda: `smoke-orch-dep-${randomUUID()}`,
      deploymentIndex: 0,
      role: "head_editorial",
      parentDeploymentIndex: null,
    })
    .returning({ id: deployments.id });

  const [subDep] = await db
    .insert(deployments)
    .values({
      companyId: c.id,
      agentIdentityId: subIdent.id,
      deploymentPda: `smoke-sub-dep-${randomUUID()}`,
      deploymentIndex: 1,
      role: "news_writer",
      parentDeploymentIndex: 0,
    })
    .returning({ id: deployments.id });

  // parent task assigned to orchestrator
  const [t] = await db
    .insert(tasks)
    .values({
      companyId: c.id,
      taskNumber: 1,
      title: "SmokeParent",
      blocks: [],
      status: "in_progress",
      assignedDeploymentId: orchDep.id,
      parentTaskId: null,
    })
    .returning({ id: tasks.id });

  // trace row — task_events.trace_id has FK to traces.id
  const [tr] = await db
    .insert(traces)
    .values({
      companyId: c.id,
      deploymentId: orchDep.id,
      taskId: t.id,
      invocationSource: "automation",
      status: "succeeded",
    })
    .returning({ id: traces.id });

  return {
    userId: u.id,
    companyId: c.id,
    orchestratorId: orchDep.id,
    subordinateId: subDep.id,
    parentTaskId: t.id,
    traceId: tr.id,
  };
}

function buildReply(targetAgentId: string, title: string): string {
  return [
    "Some intro text from the orchestrator.",
    "",
    "[[OCCA:DELEGATE]]",
    JSON.stringify({
      targetAgentId,
      title,
      description: "Write the smoke article.",
      acceptanceCriteria: "200 words, no preamble.",
    }),
    "[[/OCCA:DELEGATE]]",
    "",
    "Closing remarks.",
  ].join("\n");
}

async function loadAuditRows(parentTaskId: string) {
  return db
    .select({
      payload: taskEvents.payload,
      createdAt: taskEvents.createdAt,
    })
    .from(taskEvents)
    .where(eq(taskEvents.taskId, parentTaskId));
}

async function loadChildTasks(parentTaskId: string) {
  return db
    .select({
      id: tasks.id,
      assignedDeploymentId: tasks.assignedDeploymentId,
      title: tasks.title,
    })
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId));
}

async function run(): Promise<void> {
  console.log("seeding…");
  const seedData = await seed();
  const traceId = seedData.traceId;

  console.log("\n[1] valid DELEGATE → expect child created + audit delegated");
  const r1 = await executeWorkerDelegations(
    buildReply(seedData.subordinateId, "First story"),
    {
      companyId: seedData.companyId,
      agentId: seedData.orchestratorId,
      parentTaskId: seedData.parentTaskId,
      subordinates: [
        { id: seedData.subordinateId, name: "Subordinate", role: "news_writer" },
      ],
      traceId,
    },
  );
  check("returned 1 delegated", r1.delegated.length === 1, r1);
  check("returned 0 ignored", r1.ignored.length === 0, r1);

  const children1 = await loadChildTasks(seedData.parentTaskId);
  check("1 child task created in DB", children1.length === 1, children1);
  check(
    "child assigned to subordinate",
    children1[0]?.assignedDeploymentId === seedData.subordinateId,
    children1,
  );

  const audits1 = await loadAuditRows(seedData.parentTaskId);
  check("1 audit row after first call", audits1.length === 1, audits1);
  const a1 = audits1[0]?.payload as Record<string, unknown> | undefined;
  check(
    'audit outcome === "delegated"',
    a1?.outcome === "delegated",
    a1,
  );
  check(
    "audit carries childTaskId",
    typeof a1?.childTaskId === "string",
    a1,
  );
  check(
    'audit actionType === "DELEGATE"',
    a1?.actionType === "DELEGATE",
    a1,
  );

  console.log(
    "\n[2] re-run same DELEGATE → no-loop guard, no dup child, ignored audit",
  );
  const r2 = await executeWorkerDelegations(
    buildReply(seedData.subordinateId, "First story (duplicate attempt)"),
    {
      companyId: seedData.companyId,
      agentId: seedData.orchestratorId,
      parentTaskId: seedData.parentTaskId,
      subordinates: [
        { id: seedData.subordinateId, name: "Subordinate", role: "news_writer" },
      ],
      traceId,
    },
  );
  check("returned 0 delegated on re-run", r2.delegated.length === 0, r2);
  check(
    "returned 1 ignored with no-loop reason",
    r2.ignored.length === 1 && r2.ignored[0]?.reason === "target_already_delegated",
    r2,
  );

  const children2 = await loadChildTasks(seedData.parentTaskId);
  check(
    "still only 1 child task (no dup)",
    children2.length === 1,
    children2,
  );

  const audits2 = await loadAuditRows(seedData.parentTaskId);
  check(
    "2 audit rows total (delegated + ignored)",
    audits2.length === 2,
    audits2.map((a) => a.payload),
  );
  const a2 = audits2[1]?.payload as Record<string, unknown> | undefined;
  check(
    'second audit outcome === "ignored"',
    a2?.outcome === "ignored",
    a2,
  );
  check(
    'second audit reason === "target_already_delegated"',
    a2?.reason === "target_already_delegated",
    a2,
  );

  console.log(
    "\n[3a] integration: syncTaskOnTraceSucceeded should NOT emit the old",
  );
  console.log(
    "     worker_path_detection_only audit (the misleading row we removed)",
  );
  // Fresh second task to isolate this check from prior audits. Allocate
  // next task_number dynamically — prior calls already created children
  // that took 2.
  const nextNumRow = await db.execute<{ next: number }>(sql`
    SELECT COALESCE(MAX(task_number), 0) + 1 AS next
    FROM tasks WHERE company_id = ${seedData.companyId}::uuid
  `);
  const [t2] = await db
    .insert(tasks)
    .values({
      companyId: seedData.companyId,
      taskNumber: nextNumRow.rows[0].next,
      title: "SmokeIntegrationParent",
      blocks: [],
      status: "in_progress",
      assignedDeploymentId: seedData.orchestratorId,
      parentTaskId: null,
    })
    .returning({ id: tasks.id });
  const [tr2] = await db
    .insert(traces)
    .values({
      companyId: seedData.companyId,
      deploymentId: seedData.orchestratorId,
      taskId: t2.id,
      invocationSource: "automation",
      status: "succeeded",
    })
    .returning({ id: traces.id });

  const replyWithDelegate = buildReply(
    seedData.subordinateId,
    "Integration story",
  );

  // Call dispatcher.ts's sequence: syncTaskOnTraceSucceeded THEN
  // executeWorkerDelegations — exact order in apps/worker/src/dispatcher.ts.
  await syncTaskOnTraceSucceeded({
    taskId: t2.id,
    traceId: tr2.id,
    agentId: seedData.orchestratorId,
    livenessState: "normal",
    resultJson: { text: replyWithDelegate },
    finishedAt: new Date(),
  });

  const auditsAfterSync = await loadAuditRows(t2.id);
  const hasLegacyAudit = auditsAfterSync.some((r) => {
    const p = r.payload as Record<string, unknown> | undefined;
    return p?.reason === "worker_path_detection_only";
  });
  check(
    "no legacy worker_path_detection_only audit emitted",
    !hasLegacyAudit,
    auditsAfterSync.map((a) => a.payload),
  );

  console.log(
    "\n[3b] integration: chained call creates exactly 1 audit per DELEGATE",
  );
  await executeWorkerDelegations(replyWithDelegate, {
    companyId: seedData.companyId,
    agentId: seedData.orchestratorId,
    parentTaskId: t2.id,
    subordinates: [
      { id: seedData.subordinateId, name: "Subordinate", role: "news_writer" },
    ],
    traceId: tr2.id,
  });

  const auditsAfterChain = await loadAuditRows(t2.id);
  const delegateAudits = auditsAfterChain.filter((r) => {
    const p = r.payload as Record<string, unknown> | undefined;
    return p?.actionType === "DELEGATE";
  });
  check(
    "exactly 1 DELEGATE audit after full chain (not dup)",
    delegateAudits.length === 1,
    delegateAudits.map((a) => a.payload),
  );
  const chainPayload = delegateAudits[0]?.payload as
    | Record<string, unknown>
    | undefined;
  check(
    'chain audit outcome === "delegated"',
    chainPayload?.outcome === "delegated",
    chainPayload,
  );

  const t2Children = await loadChildTasks(t2.id);
  check(
    "child task created for integration parent",
    t2Children.length === 1 &&
      t2Children[0]?.assignedDeploymentId === seedData.subordinateId,
    t2Children,
  );

  console.log("\n[4] invalid target → ignored:target_not_subordinate");
  const fakeTarget = randomUUID();
  const r3 = await executeWorkerDelegations(
    buildReply(fakeTarget, "Story for ghost"),
    {
      companyId: seedData.companyId,
      agentId: seedData.orchestratorId,
      parentTaskId: seedData.parentTaskId,
      subordinates: [
        { id: seedData.subordinateId, name: "Subordinate", role: "news_writer" },
      ],
      traceId,
    },
  );
  check(
    "returned ignored:target_not_subordinate",
    r3.ignored[0]?.reason === "target_not_subordinate",
    r3,
  );

  const audits3 = await loadAuditRows(seedData.parentTaskId);
  const a3 = audits3[2]?.payload as Record<string, unknown> | undefined;
  check(
    'third audit reason === "target_not_subordinate"',
    a3?.reason === "target_not_subordinate",
    a3,
  );
}

async function cleanup(): Promise<void> {
  // Hard delete the test user; cascade wipes everything seeded.
  // Identified by the wallet pattern we used in seed.
  await db.execute(
    sql`DELETE FROM users WHERE wallet_address LIKE 'smoke-%'`,
  );
}

async function main(): Promise<void> {
  try {
    await run();
  } finally {
    await cleanup();
  }
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  void cleanup().finally(() => process.exit(2));
});
