// Workflow engine — server-side orchestrator that runs after a task
// completes. Loads matching workflow rules, spawns the rule's steps as
// child tasks via the existing createTaskRecord primitive, and writes a
// single WorkflowExecuted audit row to task_events so the timeline
// shows what happened.
//
// Idempotency: the engine runs once per (taskId, workflow) pair; the
// dedupe gate is the presence of a WorkflowExecuted audit event for
// the same workflow on the parent task. The pg-boss queue adds a
// second layer of dedup via singletonKey.

import { and, eq, sql } from "drizzle-orm";
import {
  agentIdentities,
  deployments,
  taskEvents,
  tasks,
  workflows as workflowsTable,
} from "@occa/shared/schema";
import type {
  SpawnStep,
  WorkflowDefinition,
  WorkflowStep,
} from "@occa/shared/workflows";
import { db } from "../../../infra/database/client";
import { createTaskRecord } from "../../../infra/database/task-creation";
import { LIMITS } from "../../../lib/limits";
import { childLogger } from "../../../lib/logger";
import { appendTaskEventBestEffort } from "../../tasks/services/events";

const log = childLogger("services:workflows:engine");

// Discriminator for what actually happened during a workflow run; the
// spawn-step / skip / meta detail is folded into a single audit row.
export interface SpawnedChildSummary {
  taskId: string;
  title: string;
  assignedDeploymentId: string | null;
  originalIndex: number;
  renamed: boolean;
}

export interface SkippedStepSummary {
  index: number;
  originalTitle: string;
  reason: string;
}

export interface WorkflowExecutedPayload {
  workflowId: string;
  workflowYamlId: string;
  workflowName: string;
  spawned: SpawnedChildSummary[];
  skipped: SkippedStepSummary[];
  capHits: string[];
}

interface ParentTaskContext {
  id: string;
  companyId: string;
  title: string;
  taskType: string;
  depth: number;
}

async function loadParentTask(
  taskId: string,
): Promise<ParentTaskContext | null> {
  const [row] = await db
    .select({
      id: tasks.id,
      companyId: tasks.companyId,
      title: tasks.title,
      taskType: tasks.taskType,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!row) return null;

  const depthRow = await db.execute<{ depth: number }>(sql`
    WITH RECURSIVE chain AS (
      SELECT id, parent_task_id, 0 AS depth FROM tasks WHERE id = ${taskId}::uuid
      UNION ALL
      SELECT t.id, t.parent_task_id, c.depth + 1
      FROM tasks t JOIN chain c ON t.id = c.parent_task_id
    )
    SELECT MAX(depth)::int AS depth FROM chain
  `);
  const depth = depthRow.rows[0]?.depth ?? 0;

  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title,
    taskType: row.taskType,
    depth,
  };
}

async function findMatchingWorkflows(
  companyId: string,
  taskType: string,
): Promise<Array<{ id: string; definition: WorkflowDefinition }>> {
  const rows = await db
    .select({
      id: workflowsTable.id,
      parsedDefinition: workflowsTable.parsedDefinition,
    })
    .from(workflowsTable)
    .where(
      and(
        eq(workflowsTable.companyId, companyId),
        eq(workflowsTable.enabled, true),
      ),
    );
  return rows
    .map((r) => ({
      id: r.id,
      definition: r.parsedDefinition as WorkflowDefinition,
    }))
    .filter((w) => w.definition.trigger.match.task_type === taskType);
}

async function alreadyEvaluated(
  taskId: string,
  workflowYamlId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: taskEvents.id })
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
  return row != null;
}

async function resolveAssignedDeployment(
  companyId: string,
  assignedTo: string,
): Promise<string | null> {
  if (assignedTo.toLowerCase() === "human") return null;
  const [row] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(
      and(
        eq(deployments.companyId, companyId),
        sql`LOWER(${agentIdentities.name}) = LOWER(${assignedTo})`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

function renderTitle(template: string, parentTitle: string): string {
  // Minimal mustache-style substitution; only `{{parent.title}}` for
  // now. Other variables (`{{parent.output}}`, etc.) wait until users
  // ask for them.
  return template.replace(/\{\{\s*parent\.title\s*\}\}/g, parentTitle);
}

function isSpawnStep(step: WorkflowStep): step is SpawnStep {
  return "title" in step;
}

interface RunOneWorkflowResult {
  payload: WorkflowExecutedPayload;
  spawnedTaskIds: string[];
}

// Cap: don't spawn from a parent at the depth ceiling — children would
// land beyond TASK_CHAIN_MAX_DEPTH. Returns a payload representing a
// no-spawn audit when the cap is hit, or null when there's headroom.
function depthCapPayload(
  parent: ParentTaskContext,
  workflowRowId: string,
  workflow: WorkflowDefinition,
): RunOneWorkflowResult | null {
  if (parent.depth + 1 <= LIMITS.TASK_CHAIN_MAX_DEPTH) return null;
  return {
    spawnedTaskIds: [],
    payload: {
      workflowId: workflowRowId,
      workflowYamlId: workflow.id,
      workflowName: workflow.name,
      spawned: [],
      skipped: workflow.steps.map((s, index) => ({
        index,
        originalTitle: isSpawnStep(s) ? s.title : s.action,
        reason: "max_depth cap reached",
      })),
      capHits: ["max_depth"],
    },
  };
}

async function runOneWorkflow(
  parent: ParentTaskContext,
  workflowRowId: string,
  workflow: WorkflowDefinition,
): Promise<RunOneWorkflowResult | null> {
  const capped = depthCapPayload(parent, workflowRowId, workflow);
  if (capped) return capped;

  const cap = LIMITS.TASK_EMIT_MAX_CHILDREN;
  const allowedSteps = workflow.steps.slice(0, cap);
  const truncated = workflow.steps.slice(cap);
  const capHits: string[] = [];
  if (truncated.length > 0) capHits.push("max_children");

  const spawned: SpawnedChildSummary[] = [];
  const spawnedTaskIds: string[] = [];
  const skipped: SkippedStepSummary[] = [];

  for (let index = 0; index < allowedSteps.length; index++) {
    const step = allowedSteps[index];
    if (!isSpawnStep(step)) {
      skipped.push({
        index,
        originalTitle: step.action,
        reason: "meta-action steps not supported",
      });
      continue;
    }
    const renderedTitle = renderTitle(step.title, parent.title);
    const assignedDeploymentId = await resolveAssignedDeployment(
      parent.companyId,
      step.assigned_to,
    );

    const newTask = await createTaskRecord({
      companyId: parent.companyId,
      title: renderedTitle,
      blocks: step.acceptance_criteria
        ? [{ type: "paragraph", text: step.acceptance_criteria }]
        : [],
      status: "todo",
      priority: "medium",
      taskType: "other",
      effortLevel: "m",
      tags: [],
      dueDate: null,
      assignedDeploymentId,
      parentTaskId: parent.id,
      createdByUserId: null,
      createdByDeploymentId: null,
      acceptanceCriteria: step.acceptance_criteria ?? null,
    });

    spawned.push({
      taskId: newTask.id,
      title: renderedTitle,
      assignedDeploymentId,
      originalIndex: index,
      renamed: false,
    });
    spawnedTaskIds.push(newTask.id);
  }

  for (let i = 0; i < truncated.length; i++) {
    const step = truncated[i];
    skipped.push({
      index: allowedSteps.length + i,
      originalTitle: isSpawnStep(step) ? step.title : step.action,
      reason: `max_children cap (${cap}) reached`,
    });
  }

  return {
    spawnedTaskIds,
    payload: {
      workflowId: workflowRowId,
      workflowYamlId: workflow.id,
      workflowName: workflow.name,
      spawned,
      skipped,
      capHits,
    },
  };
}

async function emitWorkflowExecutedEvent(
  parent: ParentTaskContext,
  payload: WorkflowExecutedPayload,
): Promise<void> {
  await appendTaskEventBestEffort({
    companyId: parent.companyId,
    taskId: parent.id,
    eventType: "agent_action_emitted",
    actorType: "system",
    actorId: "system",
    payload: {
      actionType: "WorkflowExecuted",
      channel: "http",
      workflowYamlId: payload.workflowYamlId,
      workflowId: payload.workflowId,
      workflowName: payload.workflowName,
      spawned: payload.spawned,
      skipped: payload.skipped,
      capHits: payload.capHits,
    },
  });
}

export interface RunWorkflowsForTaskResult {
  evaluated: number;
  spawnedTotal: number;
  skippedAlreadyEvaluated: number;
}

// Entry point for the pg-boss handler. Loads the parent, finds matching
// workflows, runs each one (skipping those already evaluated for this
// task), emits a WorkflowExecuted audit row per workflow run.
export async function runWorkflowsForTask(
  taskId: string,
): Promise<RunWorkflowsForTaskResult> {
  const parent = await loadParentTask(taskId);
  if (!parent) {
    log.warn({ taskId }, "task not found; skipping workflow evaluation");
    return { evaluated: 0, spawnedTotal: 0, skippedAlreadyEvaluated: 0 };
  }

  const matching = await findMatchingWorkflows(parent.companyId, parent.taskType);
  if (matching.length === 0) {
    return { evaluated: 0, spawnedTotal: 0, skippedAlreadyEvaluated: 0 };
  }

  let evaluated = 0;
  let spawnedTotal = 0;
  let skippedAlreadyEvaluated = 0;

  for (const wf of matching) {
    if (await alreadyEvaluated(parent.id, wf.definition.id)) {
      skippedAlreadyEvaluated += 1;
      continue;
    }
    const result = await runOneWorkflow(parent, wf.id, wf.definition);
    if (!result) continue;
    await emitWorkflowExecutedEvent(parent, result.payload);
    evaluated += 1;
    spawnedTotal += result.spawnedTaskIds.length;
    log.info(
      {
        taskId,
        workflowYamlId: wf.definition.id,
        spawned: result.spawnedTaskIds.length,
        capHits: result.payload.capHits,
      },
      "workflow evaluated",
    );
  }

  return { evaluated, spawnedTotal, skippedAlreadyEvaluated };
}
