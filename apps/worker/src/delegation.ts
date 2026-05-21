// Worker-side delegation for routine wakes. A routine wake carries no
// task, so the server's task-bound `[[OCCA:DELEGATE]]` handler
// (services/delegation/markers) never sees it. This runs the
// orchestrator's DELEGATE blocks: each valid one creates a top-level
// task assigned to the target and wakes the target to run it.

import { eq, sql } from "drizzle-orm";
import { companies, tasks } from "@occa/shared/schema";
import { extractActionBlocks } from "@occa/shared/markers";
import type { ContentBlock } from "@occa/shared/types";
import { db } from "./db";
import { enqueueTaskDispatch } from "./queue";

export interface RoutineDelegationCtx {
  companyId: string;
  // The routine-woken orchestrator that emitted the DELEGATE blocks.
  agentId: string;
  // The wrapper task created by the routine scheduler. Children inherit
  // this as parent_task_id so cascade.ts can wake the orchestrator back
  // when each child finishes. Null only for traces without a wrapper.
  parentTaskId: string | null;
  // Direct reports — the only valid delegation targets.
  subordinates: { id: string; name: string; role: string }[];
}

export interface RoutineDelegationResult {
  delegated: { childTaskId: string; targetAgentId: string; title: string }[];
  ignored: { reason: string }[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function executeRoutineDelegations(
  reply: string,
  ctx: RoutineDelegationCtx,
): Promise<RoutineDelegationResult> {
  const result: RoutineDelegationResult = { delegated: [], ignored: [] };
  const validTargets = new Set(ctx.subordinates.map((s) => s.id));

  for (const block of extractActionBlocks(reply)) {
    if (block.token !== "DELEGATE") continue;

    const body = block.body;
    const targetAgentId = body?.targetAgentId;
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const description =
      typeof body?.description === "string" ? body.description.trim() : "";
    const acceptanceCriteria =
      typeof body?.acceptanceCriteria === "string" &&
      body.acceptanceCriteria.trim()
        ? body.acceptanceCriteria.trim()
        : null;

    if (
      typeof targetAgentId !== "string" ||
      !UUID_RE.test(targetAgentId) ||
      !title ||
      !description
    ) {
      result.ignored.push({ reason: "invalid_payload" });
      continue;
    }
    if (!validTargets.has(targetAgentId)) {
      // Target is not one of this orchestrator's direct reports.
      result.ignored.push({ reason: "target_not_subordinate" });
      continue;
    }

    // Create the top-level task. Lock the company row to serialise the
    // per-company task_number allocation against concurrent inserts.
    const childTask = await db.transaction(async (tx) => {
      await tx
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, ctx.companyId))
        .for("update");
      const numbered = await tx.execute<{ max: number | null }>(sql`
        SELECT COALESCE(MAX(task_number), 0) AS max
        FROM tasks WHERE company_id = ${ctx.companyId}
      `);
      const taskNumber = (numbered.rows[0]?.max ?? 0) + 1;
      const blocks: ContentBlock[] = [
        { type: "paragraph", text: description },
      ];
      const [row] = await tx
        .insert(tasks)
        .values({
          companyId: ctx.companyId,
          taskNumber,
          title,
          blocks,
          status: "todo",
          assignedDeploymentId: targetAgentId,
          parentTaskId: ctx.parentTaskId,
          createdByDeploymentId: ctx.agentId,
          acceptanceCriteria,
        })
        .returning({ id: tasks.id });
      return row;
    });

    // Dispatch through the server's gated task dispatcher (pg-boss
    // `task.dispatch`). Dispatching via the worker's own wakeup() would
    // skip the verification gate + auto-save.
    await enqueueTaskDispatch(childTask.id);

    result.delegated.push({
      childTaskId: childTask.id,
      targetAgentId,
      title,
    });
  }

  return result;
}
