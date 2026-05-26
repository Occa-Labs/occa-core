// Worker-side DELEGATE handler. Routine wakes (no original task context,
// just the routine wrapper) AND continuation wakes (an in-progress task
// being nudged) both land in the worker dispatcher and never see the
// server's task-bound `[[OCCA:DELEGATE]]` handler. This module spawns
// the orchestrator's DELEGATE blocks as child tasks regardless of which
// path woke them.
//
// Emits an `agent_action_emitted` audit row per block with the real
// outcome (delegated / ignored:<reason>), so the timeline reflects what
// actually happened on the worker path.

import { eq, sql } from "drizzle-orm";
import { companies, tasks } from "@occa/shared/schema";
import { extractActionBlocks } from "@occa/shared/markers";
import type { ContentBlock } from "@occa/shared/types";
import { db } from "./db";
import { enqueueTaskDispatch } from "./queue";
import { appendTaskEventBestEffort } from "./task-events";

export interface WorkerDelegationCtx {
  companyId: string;
  // The agent that emitted the DELEGATE blocks (routine orchestrator,
  // or any agent whose trace was dispatched by the worker).
  agentId: string;
  // Parent for any spawned child. For a routine wake this is the wrapper
  // task created by the scheduler; for a continuation it is the current
  // task being continued. Either way cascade.ts uses it to wake the
  // emitter when each child finishes. Null only when neither exists.
  parentTaskId: string | null;
  // Direct reports of the emitter — the only valid delegation targets.
  subordinates: { id: string; name: string; role: string }[];
  // Trace that produced the reply — stamped on audit rows + child task
  // dispatch enqueue context.
  traceId: string;
}

export interface WorkerDelegationResult {
  delegated: { childTaskId: string; targetAgentId: string; title: string }[];
  ignored: { reason: string }[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function executeWorkerDelegations(
  reply: string,
  ctx: WorkerDelegationCtx,
): Promise<WorkerDelegationResult> {
  const result: WorkerDelegationResult = { delegated: [], ignored: [] };
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
      await emitAudit(ctx, block.body ?? null, "ignored", "invalid_payload");
      continue;
    }
    if (!validTargets.has(targetAgentId)) {
      result.ignored.push({ reason: "target_not_subordinate" });
      await emitAudit(
        ctx,
        block.body ?? null,
        "ignored",
        "target_not_subordinate",
      );
      continue;
    }

    // No-loop guard: refuse to re-delegate to a teammate who already has
    // a child under the same parent. Mirrors the server-side handler at
    // services/delegation/markers/handlers.ts:handleDelegateBlock. Without
    // this, a continuation re-fire (agent re-emits the same DELEGATE on a
    // nudge wake) would silently duplicate the child task.
    if (ctx.parentTaskId !== null) {
      const existingChildren = await db
        .select({ assignedDeploymentId: tasks.assignedDeploymentId })
        .from(tasks)
        .where(eq(tasks.parentTaskId, ctx.parentTaskId));
      if (
        existingChildren.some(
          (c) => c.assignedDeploymentId === targetAgentId,
        )
      ) {
        result.ignored.push({ reason: "target_already_delegated" });
        await emitAudit(
          ctx,
          block.body ?? null,
          "ignored",
          "target_already_delegated",
        );
        continue;
      }
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
    await emitAudit(ctx, block.body ?? null, "delegated", undefined, {
      childTaskId: childTask.id,
    });
  }

  return result;
}

async function emitAudit(
  ctx: WorkerDelegationCtx,
  actionPayload: Record<string, unknown> | null,
  outcome: "delegated" | "ignored",
  reason: string | undefined,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (ctx.parentTaskId === null) return;
  await appendTaskEventBestEffort({
    companyId: ctx.companyId,
    taskId: ctx.parentTaskId,
    eventType: "agent_action_emitted",
    actorType: "agent",
    actorId: ctx.agentId,
    payload: {
      actionType: "DELEGATE",
      channel: "block_marker",
      outcome,
      ...(reason ? { reason } : {}),
      ...extra,
      actionPayload,
    },
    traceId: ctx.traceId,
  });
}
