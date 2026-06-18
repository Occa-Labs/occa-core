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

import { and, desc, eq, sql } from "drizzle-orm";
import {
  agentIdentities,
  deployments,
  documents,
  taskEvents,
  tasks,
  workflowRuns,
  workflows as workflowsTable,
} from "@occa/shared/schema";
import type { ContentBlock } from "@occa/shared/types";
import type {
  SpawnStep,
  WorkflowDefinition,
  WorkflowStep,
} from "@occa/shared/workflows";
import { db } from "../../../infra/database/client";
import { createTaskRecord } from "../../../infra/database/task-creation";
import type { WorkflowStartJobData } from "../../../infra/queue/boss";
import { enqueueTaskDispatch } from "../../../infra/queue/task-worker";
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
    .filter(
      (w) =>
        // Sequential workflows advance via their own run cursor and are
        // started explicitly by a routine fire — never by task_type
        // matching. Only parallel (fan-out) workflows trigger here.
        w.definition.execution !== "sequential" &&
        w.definition.trigger.match.task_type === taskType,
    );
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

// Resolve a step's `assigned_to` to a deployment id within the company.
// Three forms:
//   • "human"        → null (left unassigned for a teammate to pick up)
//   • "role:<role>"  → first deployment with that role. Portable across
//                      environments where agent names differ; the news
//                      pipeline uses this so one workflow runs in both
//                      local and prod.
//   • "<agent name>" → deployment of the named agent (legacy form)
async function resolveAssignedDeployment(
  companyId: string,
  assignedTo: string,
): Promise<string | null> {
  if (assignedTo.toLowerCase() === "human") return null;

  const roleMatch = /^role:(.+)$/i.exec(assignedTo.trim());
  if (roleMatch) {
    const role = roleMatch[1].trim();
    const [row] = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.companyId, companyId),
          sql`LOWER(${deployments.role}) = LOWER(${role})`,
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

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

// Create one step task and wire it for dispatch — shared by the parallel
// fan-out path and the sequential advance path. Returns the new task id.
// Mirrors routes/tasks.ts user-create so the spawned child gets the same
// lifecycle visibility + auto-dispatch when assigned; without the
// task_assigned event + dispatch enqueue an assigned child sits in
// `todo` forever.
async function spawnChildTask(args: {
  companyId: string;
  parentTaskId: string;
  title: string;
  acceptanceCriteria: string | null;
  assignedDeploymentId: string | null;
  workflowRunId?: string | null;
  workflowStepIndex?: number | null;
  // Prepended to the task body — the prior step's output (or the run's
  // standing mandate for step 0) so each step is born with context, not
  // a bare title.
  contextBlocks?: ContentBlock[];
}): Promise<string> {
  const blocks: ContentBlock[] = [
    ...(args.contextBlocks ?? []),
    ...(args.acceptanceCriteria
      ? [{ type: "paragraph" as const, text: args.acceptanceCriteria }]
      : []),
  ];
  const newTask = await createTaskRecord({
    companyId: args.companyId,
    title: args.title,
    blocks,
    status: "todo",
    priority: "medium",
    taskType: "other",
    effortLevel: "m",
    tags: [],
    dueDate: null,
    assignedDeploymentId: args.assignedDeploymentId,
    parentTaskId: args.parentTaskId,
    createdByUserId: null,
    createdByDeploymentId: null,
    acceptanceCriteria: args.acceptanceCriteria,
    workflowRunId: args.workflowRunId ?? null,
    workflowStepIndex: args.workflowStepIndex ?? null,
  });

  if (args.assignedDeploymentId) {
    void appendTaskEventBestEffort({
      companyId: args.companyId,
      taskId: newTask.id,
      eventType: "task_assigned",
      actorType: "system",
      actorId: "system",
      payload: { deploymentId: args.assignedDeploymentId },
    });
    void enqueueTaskDispatch(newTask.id).catch((err) =>
      log.error(
        { err, taskId: newTask.id },
        "workflow-spawned task dispatch enqueue failed",
      ),
    );
  }

  return newTask.id;
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

    const newTaskId = await spawnChildTask({
      companyId: parent.companyId,
      parentTaskId: parent.id,
      title: renderedTitle,
      acceptanceCriteria: step.acceptance_criteria ?? null,
      assignedDeploymentId,
    });

    spawned.push({
      taskId: newTaskId,
      title: renderedTitle,
      assignedDeploymentId,
      originalIndex: index,
      renamed: false,
    });
    spawnedTaskIds.push(newTaskId);
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

// ── Sequential workflow runs ─────────────────────────────────────────
// A sequential workflow advances one step at a time under a shared
// parent (the routine wrapper). The workflow_runs row owns the cursor;
// step children carry workflowRunId + workflowStepIndex back-pointers.

interface WorkflowRunRow {
  id: string;
  companyId: string;
  workflowRowId: string;
  workflowYamlId: string;
  parentTaskId: string | null;
  currentStepIndex: number;
  status: string;
}

async function loadEnabledWorkflowByYamlId(
  companyId: string,
  yamlId: string,
): Promise<{ id: string; definition: WorkflowDefinition } | null> {
  const [row] = await db
    .select({
      id: workflowsTable.id,
      parsedDefinition: workflowsTable.parsedDefinition,
    })
    .from(workflowsTable)
    .where(
      and(
        eq(workflowsTable.companyId, companyId),
        eq(workflowsTable.yamlId, yamlId),
        eq(workflowsTable.enabled, true),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { id: row.id, definition: row.parsedDefinition as WorkflowDefinition };
}

// Spawn the step at `stepIndex` under the run's parent. Phase 1 handles
// spawn steps only; gate/upload step kinds land in later phases. Returns
// the new task id, or null if the step is missing / not a spawn step.
async function spawnSequentialStep(
  run: WorkflowRunRow,
  definition: WorkflowDefinition,
  stepIndex: number,
  parentTitle: string,
  contextBlocks: ContentBlock[],
): Promise<string | null> {
  const step = definition.steps[stepIndex];
  if (!step || !isSpawnStep(step) || !run.parentTaskId) return null;
  const assignedDeploymentId = await resolveAssignedDeployment(
    run.companyId,
    step.assigned_to,
  );
  if (!assignedDeploymentId) {
    log.warn(
      {
        runId: run.id,
        stepIndex,
        assignedTo: step.assigned_to,
      },
      "sequential step assignee did not resolve; spawning unassigned",
    );
  }
  return spawnChildTask({
    companyId: run.companyId,
    parentTaskId: run.parentTaskId,
    title: renderTitle(step.title, parentTitle),
    acceptanceCriteria: step.acceptance_criteria ?? null,
    assignedDeploymentId,
    workflowRunId: run.id,
    workflowStepIndex: stepIndex,
    contextBlocks,
  });
}

async function loadTaskTitle(taskId: string): Promise<string> {
  const [row] = await db
    .select({ title: tasks.title })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  return row?.title ?? "";
}

// The standing mandate carried on the run's container task (the routine's
// description, set when the wrapper was minted). Step 0 inherits it so the
// first agent knows what the cycle is about without a separately authored
// brief. Returns "" when the container has no prose blocks.
async function loadContainerMandateText(parentTaskId: string): Promise<string> {
  const [row] = await db
    .select({ blocks: tasks.blocks })
    .from(tasks)
    .where(eq(tasks.id, parentTaskId))
    .limit(1);
  const blocks = (row?.blocks as ContentBlock[] | undefined) ?? [];
  return blocks
    .filter((b): b is { type: "paragraph"; text: string } => b.type === "paragraph")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

// The just-completed step's deliverable, so the next step is born with the
// prior output in hand. Prefers the auto-saved document (full markdown);
// falls back to the task's agent_result preview, then "".
async function loadStepOutputText(taskId: string): Promise<string> {
  const [doc] = await db
    .select({ content: documents.content })
    .from(documents)
    .where(eq(documents.taskId, taskId))
    .orderBy(desc(documents.createdAt))
    .limit(1);
  if (doc?.content?.trim()) return doc.content.trim();

  const [row] = await db
    .select({ blocks: tasks.blocks })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  const blocks = (row?.blocks as ContentBlock[] | undefined) ?? [];
  const result = blocks.find((b) => b.type === "agent_result");
  return result && result.type === "agent_result"
    ? (result.preview ?? "").trim()
    : "";
}

// Wrap context text as a labelled paragraph block for a step body. Empty
// text yields no block (the step just gets its acceptance criteria).
function contextBlock(label: string, text: string): ContentBlock[] {
  if (!text) return [];
  return [{ type: "paragraph", text: `${label}\n\n${text}` }];
}

// Start a sequential run: create the run row under the routine wrapper
// and spawn step 0. Idempotent per wrapper task — a re-fired start job
// finds the existing run and no-ops.
export async function startWorkflowRun(
  job: WorkflowStartJobData,
): Promise<void> {
  const { parentTaskId, companyId, workflowYamlId } = job;

  const wf = await loadEnabledWorkflowByYamlId(companyId, workflowYamlId);
  if (!wf) {
    log.warn(
      { companyId, workflowYamlId, parentTaskId },
      "workflow not found / disabled; cannot start run",
    );
    return;
  }
  if (wf.definition.execution !== "sequential") {
    log.warn(
      { workflowYamlId, parentTaskId },
      "start requested for non-sequential workflow; ignoring",
    );
    return;
  }

  const [existing] = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(eq(workflowRuns.parentTaskId, parentTaskId))
    .limit(1);
  if (existing) {
    log.info(
      { runId: existing.id, parentTaskId },
      "run already exists for wrapper; skipping start",
    );
    return;
  }

  const [run] = await db
    .insert(workflowRuns)
    .values({
      companyId,
      workflowRowId: wf.id,
      workflowYamlId,
      parentTaskId,
      currentStepIndex: 0,
      status: "running",
    })
    .returning({ id: workflowRuns.id });

  // Tag the container itself with the run so its task detail shows the
  // bound workflow. workflowStepIndex stays null (it is the parent, not a
  // step), so advanceWorkflowRun never treats its completion as a step.
  await db
    .update(tasks)
    .set({ workflowRunId: run.id, updatedAt: new Date() })
    .where(eq(tasks.id, parentTaskId));

  const runRow: WorkflowRunRow = {
    id: run.id,
    companyId,
    workflowRowId: wf.id,
    workflowYamlId,
    parentTaskId,
    currentStepIndex: 0,
    status: "running",
  };
  const parentTitle = await loadTaskTitle(parentTaskId);
  const mandate = await loadContainerMandateText(parentTaskId);
  const step0 = await spawnSequentialStep(
    runRow,
    wf.definition,
    0,
    parentTitle,
    contextBlock("Your standing mandate for this cycle:", mandate),
  );
  log.info(
    { runId: run.id, workflowYamlId, parentTaskId, step0 },
    "workflow run started",
  );
}

// Advance a sequential run when one of its step tasks completes. Spawns
// the next step, or marks the run done at the end. Idempotent: only the
// completion whose step index matches the run cursor advances, so a
// duplicate done-event can't double-spawn.
async function advanceWorkflowRun(completed: {
  id: string;
  workflowRunId: string;
  workflowStepIndex: number | null;
}): Promise<{ spawned: number }> {
  const [run] = await db
    .select({
      id: workflowRuns.id,
      companyId: workflowRuns.companyId,
      workflowRowId: workflowRuns.workflowRowId,
      workflowYamlId: workflowRuns.workflowYamlId,
      parentTaskId: workflowRuns.parentTaskId,
      currentStepIndex: workflowRuns.currentStepIndex,
      status: workflowRuns.status,
    })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, completed.workflowRunId))
    .limit(1);
  if (!run) {
    log.warn(
      { runId: completed.workflowRunId, taskId: completed.id },
      "workflow run not found for completed step",
    );
    return { spawned: 0 };
  }
  if (run.status !== "running") {
    log.info(
      { runId: run.id, status: run.status },
      "run not running; skip advance",
    );
    return { spawned: 0 };
  }
  if (
    completed.workflowStepIndex == null ||
    completed.workflowStepIndex !== run.currentStepIndex
  ) {
    log.info(
      {
        runId: run.id,
        completedStep: completed.workflowStepIndex,
        cursor: run.currentStepIndex,
      },
      "completed step does not match run cursor; skip (dup or stale)",
    );
    return { spawned: 0 };
  }

  const wf = await loadEnabledWorkflowByYamlId(
    run.companyId,
    run.workflowYamlId,
  );
  if (!wf) {
    log.warn(
      { runId: run.id, workflowYamlId: run.workflowYamlId },
      "workflow not found / disabled; cannot advance run",
    );
    return { spawned: 0 };
  }

  const nextIndex = run.currentStepIndex + 1;
  if (nextIndex >= wf.definition.steps.length) {
    await db
      .update(workflowRuns)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(workflowRuns.id, run.id));
    // Close the container so the run doesn't sit in_progress forever once
    // every step is done. A raw status update (not the finalize path) so
    // it does NOT bill — the container is a wrapper, the paid work is the
    // steps. Guarded to not re-close an already-settled container.
    if (run.parentTaskId) {
      await db
        .update(tasks)
        .set({ status: "done", updatedAt: new Date() })
        .where(
          and(
            eq(tasks.id, run.parentTaskId),
            sql`${tasks.status} NOT IN ('done', 'archived')`,
          ),
        );
      void appendTaskEventBestEffort({
        companyId: run.companyId,
        taskId: run.parentTaskId,
        eventType: "task_status_changed",
        actorType: "system",
        actorId: "system",
        payload: { to: "done", reason: "workflow_run_complete" },
      });
    }
    log.info(
      { runId: run.id, container: run.parentTaskId },
      "workflow run complete",
    );
    return { spawned: 0 };
  }

  // Advance the cursor with a compare-and-set on the old value so a
  // racing duplicate that slipped past the index check above still can't
  // double-advance.
  const updated = await db
    .update(workflowRuns)
    .set({ currentStepIndex: nextIndex, updatedAt: new Date() })
    .where(
      and(
        eq(workflowRuns.id, run.id),
        eq(workflowRuns.currentStepIndex, run.currentStepIndex),
      ),
    )
    .returning({ id: workflowRuns.id });
  if (updated.length === 0) {
    log.info({ runId: run.id }, "cursor moved concurrently; skip advance");
    return { spawned: 0 };
  }

  const runRow: WorkflowRunRow = { ...run };
  const parentTitle = run.parentTaskId
    ? await loadTaskTitle(run.parentTaskId)
    : "";
  // Carry the just-completed step's deliverable into the next step so the
  // pipeline flows (brief → draft → verify) instead of each step starting
  // blind.
  const prevStep = wf.definition.steps[run.currentStepIndex];
  const prevLabel =
    prevStep && isSpawnStep(prevStep)
      ? `Input from the previous step (${renderTitle(prevStep.title, parentTitle)}):`
      : "Input from the previous step:";
  const prevOutput = await loadStepOutputText(completed.id);
  const spawnedId = await spawnSequentialStep(
    runRow,
    wf.definition,
    nextIndex,
    parentTitle,
    contextBlock(prevLabel, prevOutput),
  );
  log.info(
    { runId: run.id, stepIndex: nextIndex, spawnedTaskId: spawnedId },
    "workflow run advanced",
  );
  return { spawned: spawnedId ? 1 : 0 };
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
  // Sequential advance path: if the completed task is itself a workflow
  // step, advance its run (spawn the next step / finish) instead of the
  // task_type fan-out.
  const [stepRow] = await db
    .select({
      workflowRunId: tasks.workflowRunId,
      workflowStepIndex: tasks.workflowStepIndex,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (stepRow?.workflowRunId) {
    const adv = await advanceWorkflowRun({
      id: taskId,
      workflowRunId: stepRow.workflowRunId,
      workflowStepIndex: stepRow.workflowStepIndex,
    });
    return {
      evaluated: 1,
      spawnedTotal: adv.spawned,
      skippedAlreadyEvaluated: 0,
    };
  }

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
