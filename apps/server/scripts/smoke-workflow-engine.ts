#!/usr/bin/env tsx
// Engine-only smoke test for the workflow runtime.
//
// Bypasses the pg-boss queue + poller and calls runWorkflowsForTask
// directly so the test stays fast and deterministic. Validates:
//   - matching workflow is found by task_type
//   - children are spawned via createTaskRecord
//   - WorkflowExecuted audit row is written with the right payload
//   - max_children cap truncates spawn list (3 max)
//   - alreadyEvaluated short-circuits a re-run
//   - {{parent.title}} substitution renders correctly
//
// Usage (from apps/server/):
//
//   pnpm smoke:workflow-engine
//
// Cleanup runs at the end so the suite is safe to re-run.

import { and, eq, sql } from "drizzle-orm";
import {
  agentIdentities,
  companies,
  deployments,
  taskEvents,
  tasks,
  workflows,
} from "@occa/shared/schema";
import { db } from "../src/infra/database/client";
import { runWorkflowsForTask } from "../src/features/workflows/services/engine";
import { parseWorkflowYaml } from "@occa/shared/workflows";

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

function buildLinearYaml(args: {
  yamlId: string;
  taskType: string;
  steps: number;
}): string {
  const lines = [
    `id: ${args.yamlId}`,
    `name: Smoke Test Workflow ${args.yamlId}`,
    `trigger:`,
    `  when: task.completed`,
    `  match:`,
    `    task_type: ${args.taskType}`,
    `steps:`,
  ];
  for (let i = 0; i < args.steps; i++) {
    lines.push(
      `  - title: "Step ${i + 1} for {{parent.title}}"`,
      `    assigned_to: human`,
    );
  }
  return lines.join("\n");
}

async function getTestCompanyId(): Promise<string> {
  const [row] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.kind, "user"))
    .limit(1);
  if (!row) throw new Error("no user-kind company found; seed one first");
  return row.id;
}

async function insertWorkflow(
  companyId: string,
  yamlText: string,
): Promise<string> {
  const parsed = parseWorkflowYaml(yamlText);
  if (!parsed.ok) {
    throw new Error(
      `seed YAML invalid: ${JSON.stringify(parsed.error)}`,
    );
  }
  const def = parsed.value.definition;
  const [row] = await db
    .insert(workflows)
    .values({
      companyId,
      yamlId: def.id,
      name: def.name,
      description: def.description ?? null,
      yamlText: parsed.value.yamlText,
      parsedDefinition: def,
      enabled: true,
    })
    .returning({ id: workflows.id });
  return row.id;
}

async function insertParentTask(args: {
  companyId: string;
  title: string;
  taskType: string;
  output: string;
}): Promise<string> {
  const taskNumberRow = await db.execute<{ next: number }>(sql`
    SELECT COALESCE(MAX(task_number), 0) + 1 AS next
    FROM tasks WHERE company_id = ${args.companyId}::uuid
  `);
  const taskNumber = taskNumberRow.rows[0].next;
  const [row] = await db
    .insert(tasks)
    .values({
      companyId: args.companyId,
      taskNumber,
      title: args.title,
      taskType: args.taskType,
      status: "done",
      priority: "medium",
      effortLevel: "m",
      tags: [],
      blocks: [
        {
          type: "agent_result",
          traceId: "smoke-test-trace",
          agentId: "smoke-test-agent",
          agentName: "Smoke Tester",
          timestamp: new Date().toISOString(),
          preview: args.output,
        },
      ],
      parentTaskId: null,
    })
    .returning({ id: tasks.id });
  return row.id;
}

async function deleteWorkflowsByYamlId(
  companyId: string,
  yamlIds: string[],
): Promise<void> {
  for (const id of yamlIds) {
    await db
      .delete(workflows)
      .where(
        and(eq(workflows.companyId, companyId), eq(workflows.yamlId, id)),
      );
  }
}

async function deleteTaskAndChildren(parentTaskId: string): Promise<void> {
  // Children first (FK cascade also handles this, but explicit is safer
  // in case anything references them).
  await db.delete(tasks).where(eq(tasks.parentTaskId, parentTaskId));
  await db.delete(tasks).where(eq(tasks.id, parentTaskId));
}

async function getWorkflowExecutedRow(
  taskId: string,
  workflowYamlId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ payload: taskEvents.payload })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, taskId),
        eq(taskEvents.eventType, "agent_action_emitted"),
        sql`${taskEvents.payload}->>'actionType' = 'WorkflowExecuted'`,
        sql`${taskEvents.payload}->>'workflowYamlId' = ${workflowYamlId}`,
      ),
    )
    .limit(1);
  return (row?.payload as Record<string, unknown>) ?? null;
}

async function countChildren(parentTaskId: string): Promise<number> {
  const r = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId));
  return r.length;
}

async function main(): Promise<void> {
  const companyId = await getTestCompanyId();
  console.log(`smoke company: ${companyId}`);

  const createdYamlIds: string[] = [];
  const createdParentIds: string[] = [];

  try {
    console.log("\n--- 1. linear workflow, spawn-all ---");
    const yaml1 = buildLinearYaml({
      yamlId: "smoke-engine-linear-strict",
      taskType: "smoke-strict",
      steps: 2,
    });
    await insertWorkflow(companyId, yaml1);
    createdYamlIds.push("smoke-engine-linear-strict");

    const parent1 = await insertParentTask({
      companyId,
      title: "Strict workflow parent",
      taskType: "smoke-strict",
      output: "Done — produced 3 numeric stats and 2 cited sources.",
    });
    createdParentIds.push(parent1);

    const r1 = await runWorkflowsForTask(parent1);
    check("evaluated 1 workflow", r1.evaluated === 1, r1);
    check("spawned 2 children (one per step)", r1.spawnedTotal === 2);

    const audit1 = await getWorkflowExecutedRow(
      parent1,
      "smoke-engine-linear-strict",
    );
    check("WorkflowExecuted audit row exists", audit1 !== null);
    check(
      "audit spawned has 2 entries",
      Array.isArray(audit1?.spawned) &&
        (audit1!.spawned as unknown[]).length === 2,
    );
    check(
      "audit skipped is empty",
      Array.isArray(audit1?.skipped) &&
        (audit1!.skipped as unknown[]).length === 0,
    );

    const childCount1 = await countChildren(parent1);
    check("DB has 2 child tasks under parent", childCount1 === 2);

    console.log("\n--- 2. re-run is no-op (alreadyEvaluated dedup) ---");
    const r1again = await runWorkflowsForTask(parent1);
    check("evaluated 0 (skipped)", r1again.evaluated === 0);
    check("spawnedTotal 0", r1again.spawnedTotal === 0);
    check("skippedAlreadyEvaluated 1", r1again.skippedAlreadyEvaluated === 1);
    const childCountAfterRerun = await countChildren(parent1);
    check(
      "child count unchanged (no double-spawn)",
      childCountAfterRerun === childCount1,
    );

    console.log("\n--- 3. max_children cap truncates 5 steps to 3 ---");
    const yaml2 = buildLinearYaml({
      yamlId: "smoke-engine-cap-test",
      taskType: "smoke-cap",
      steps: 5,
    });
    await insertWorkflow(companyId, yaml2);
    createdYamlIds.push("smoke-engine-cap-test");

    const parent2 = await insertParentTask({
      companyId,
      title: "Cap test parent",
      taskType: "smoke-cap",
      output: "Result with five expected follow-ups.",
    });
    createdParentIds.push(parent2);

    const r2 = await runWorkflowsForTask(parent2);
    check("evaluated 1", r2.evaluated === 1);
    check("spawned exactly 3 (cap)", r2.spawnedTotal === 3);

    const audit2 = await getWorkflowExecutedRow(
      parent2,
      "smoke-engine-cap-test",
    );
    check(
      "audit capHits includes 'max_children'",
      Array.isArray(audit2?.capHits) &&
        (audit2!.capHits as string[]).includes("max_children"),
    );

    console.log("\n--- 4. no matching workflow → no-op ---");
    const parent3 = await insertParentTask({
      companyId,
      title: "Unrelated parent",
      taskType: "smoke-no-match",
      output: "No workflow listens for this taskType.",
    });
    createdParentIds.push(parent3);

    const r3 = await runWorkflowsForTask(parent3);
    check("evaluated 0", r3.evaluated === 0);
    check("spawnedTotal 0", r3.spawnedTotal === 0);
    check(
      "no children spawned",
      (await countChildren(parent3)) === 0,
    );

    console.log("\n--- 5. {{parent.title}} substitution renders correctly ---");
    const audit1Spawned = audit1?.spawned as Array<{ title: string }>;
    const titlesIncludeParent = audit1Spawned.every((s) =>
      s.title.includes("Strict workflow parent"),
    );
    check(
      "all spawned child titles substituted parent.title",
      titlesIncludeParent,
      audit1Spawned.map((s) => s.title),
    );
  } finally {
    console.log("\n--- cleanup ---");
    for (const id of createdParentIds) {
      try {
        await deleteTaskAndChildren(id);
      } catch (err) {
        console.warn("  cleanup task failed:", err);
      }
    }
    await deleteWorkflowsByYamlId(companyId, createdYamlIds);
    await db.$client.end();
  }
}

main()
  .then(() => {
    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("smoke test crashed:", err);
    process.exit(1);
  });
