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

import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  agentIdentities,
  companyTools,
  deployments,
  documents,
  taskEvents,
  tasks,
  workflowRuns,
  workflows as workflowsTable,
} from "@occa/shared/schema";
import type { ContentBlock } from "@occa/shared/types";
import {
  resolveOutputRefs,
  type SpawnStep,
  type WorkflowDefinition,
  type WorkflowStep,
} from "@occa/shared/workflows";
import { db } from "../../../infra/database/client";
import { createTaskRecord } from "../../../infra/database/task-creation";
import type { WorkflowStartJobData } from "../../../infra/queue/boss";
import { enqueueTaskDispatch } from "../../../infra/queue/task-worker";
import { LIMITS } from "../../../lib/limits";
import { childLogger } from "../../../lib/logger";
import { appendTaskEventBestEffort } from "../../tasks/services/events";
import { invokeTool } from "../../tools/services/invoke";

const log = childLogger("services:workflows:engine");

// How many times a gate FAIL verdict may bounce the run back to the draft
// step before the engine force-kills it. Used when the workflow definition
// omits `caps.max_revisions`. Guards against an infinite
// draft→verify→gate→fail loop.
const DEFAULT_MAX_REVISIONS = 2;

// How many times a step with `on_error: retry` may be re-spawned after its task
// parks in `error` before the engine gives up and fails the run. Bounds the
// re-spawn loop so a permanently-broken step can't run forever.
const MAX_STEP_RETRIES = 3;

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
  // How many gate-fail bounces this run has taken. Used to disambiguate the
  // titles of re-spawned step tasks: revision rounds get a "· rev N" suffix
  // so the board doesn't show three identical "Editorial gate" rows.
  reviseCount: number;
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

// Canonical instruction prepended to a gate step's body. The engine reads
// the GATE_VERDICT marker deterministically, so the assignee must always
// know the exact contract regardless of how the step's acceptance criteria
// are authored. A missing/invalid verdict is treated as fail upstream.
const GATE_INSTRUCTION =
  "GATE STEP. Review the work above against this step's instructions, then " +
  "END your reply with exactly one verdict marker (raw JSON between the " +
  "tags, no code fences):\n\n" +
  "[[OCCA:GATE_VERDICT]]\n" +
  '{ "verdict": "go", "reason": "<one line>" }\n' +
  "[[/OCCA:GATE_VERDICT]]\n\n" +
  "verdict values:\n" +
  "- go: passes. The work advances to the next step.\n" +
  "- fail: needs revision. It returns to an earlier step for rework — state " +
  "what must change in your reply so it can be acted on.\n" +
  "- kill: cannot be salvaged. The run ends here.\n\n" +
  "A missing or malformed verdict is treated as fail, so always emit one.";

// Spawn the step at `stepIndex` under the run's parent. The step's authored
// `prompt` leads the task body, then (for a gate) the verdict-marker contract,
// then the prior step's output. Returns the new task id, or null if the step is
// missing / not a spawn step.
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
  // Body lead: the author's per-step prompt (what to do / what the output must
  // look like), then the gate's verdict-marker contract for gate steps (a
  // mechanism the engine owns), then the carried context. The engine injects
  // the prompt verbatim — it never reads or interprets it.
  const leadBlocks: ContentBlock[] = [];
  if (step.prompt) {
    leadBlocks.push({ type: "paragraph", text: step.prompt });
  }
  if (step.kind === "gate") {
    leadBlocks.push({ type: "paragraph", text: GATE_INSTRUCTION });
  }
  // Standing cross-step context so every agent stays connected to the cycle,
  // not just the immediately-prior output. Kept light: the brief (the angle +
  // intended sources) inline, plus a list of earlier deliverables as document
  // ids the agent can fetch on demand — full earlier docs are NOT dumped in.
  const standingBlocks: ContentBlock[] = [];
  // Step 1's prior output already IS the brief; only steps further down need it
  // re-surfaced as the standing mandate.
  if (stepIndex >= 2) {
    const briefText = await loadDoneStepOutput(run.id, 0);
    standingBlocks.push(
      ...contextBlock(
        "Cycle brief — the standing mandate and intended sources for this story:",
        briefText,
      ),
    );
  }
  if (stepIndex >= 1) {
    const refs = await loadPriorStepDocRefs(run.id, stepIndex);
    if (refs.length > 0) {
      const list = refs.map((r) => `- ${r.title}: document ${r.docId}`).join("\n");
      standingBlocks.push(
        ...contextBlock(
          "Earlier deliverables in this cycle — fetch the full text by id with your documents tool if you need more than the input below:",
          list,
        ),
      );
    }
  }
  const blocks: ContentBlock[] = [...leadBlocks, ...standingBlocks, ...contextBlocks];
  // Title shape: "<step> [· rev N] - <parent cycle>". The step name leads so
  // the board stays scannable by step rather than a wall of identical cycle
  // prefixes; the cycle ref trails so the same step across different cycles
  // still differs. The parent suffix is skipped when the rendered step already
  // echoes it (a {{parent.title}} template) so it never doubles.
  const stepLabel = renderTitle(step.title, parentTitle);
  const stepPart =
    run.reviseCount > 0 ? `${stepLabel} · rev ${run.reviseCount}` : stepLabel;
  const title =
    parentTitle && !stepLabel.includes(parentTitle)
      ? `${stepPart} - ${parentTitle}`
      : stepPart;
  return spawnChildTask({
    companyId: run.companyId,
    parentTaskId: run.parentTaskId,
    title,
    acceptanceCriteria: step.acceptance_criteria ?? null,
    assignedDeploymentId,
    workflowRunId: run.id,
    workflowStepIndex: stepIndex,
    contextBlocks: blocks,
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
    reviseCount: 0,
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

// Close the run's container task once the run terminates (done or killed).
// A raw status update, NOT the finalize path, so the wrapper does not bill —
// the paid work is the steps. Guarded against re-closing a settled container.
async function closeRunContainer(
  run: { id: string; companyId: string; parentTaskId: string | null },
  reason: string,
): Promise<void> {
  // Cancel any step task still in flight when the run ends. On a normal finish
  // there are none (every step is already done); on kill/fail this stops a dead
  // run from leaving children running on the board and prevents their late
  // completion from looking like live work. Archived (not deleted) so the
  // attempt stays auditable. A claude turn already mid-flight can't be aborted,
  // but its result is harmless: the advance path bails on a non-running run, so
  // no further step spawns and no re-dispatch happens.
  await db
    .update(tasks)
    .set({
      archivedAt: new Date(),
      archiveReason: `workflow_${reason}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tasks.workflowRunId, run.id),
        // Step tasks only — the container task (step_index NULL) is closed by
        // the dedicated parent update below, not archived here.
        sql`${tasks.workflowStepIndex} IS NOT NULL`,
        sql`${tasks.status} IN ('todo', 'in_progress', 'review')`,
      ),
    );

  if (!run.parentTaskId) return;
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
    payload: { to: "done", reason },
  });
}

// Mark the run done (all steps cleared) and close its container.
async function finishRun(
  run: { id: string; companyId: string; parentTaskId: string | null },
  reason: string,
): Promise<void> {
  await db
    .update(workflowRuns)
    .set({ status: "done", updatedAt: new Date() })
    .where(eq(workflowRuns.id, run.id));
  await closeRunContainer(run, reason);
  log.info({ runId: run.id, container: run.parentTaskId }, "workflow run complete");
}

// Mark the run killed (gate kill verdict / revise cap) and close its
// container. Steps already done stay done/paid — done ≠ published, so the
// company isn't charged again and no unpublished work is undone.
async function killRun(
  run: { id: string; companyId: string; parentTaskId: string | null },
  reason: string,
): Promise<void> {
  await db
    .update(workflowRuns)
    .set({ status: "killed", updatedAt: new Date() })
    .where(eq(workflowRuns.id, run.id));
  await closeRunContainer(run, reason);
  log.warn(
    { runId: run.id, container: run.parentTaskId, reason },
    "workflow run killed by gate",
  );
}

// Mark the run failed (a step's task errored and its policy is fail_run) and
// close its container so the run can't sit "In Progress" forever. Done steps
// stay done/paid; the routine fires a fresh cycle next tick. The errored step
// task remains in the board's "Needs attention" as the failure record.
async function failRun(
  run: { id: string; companyId: string; parentTaskId: string | null },
  reason: string,
): Promise<void> {
  await db
    .update(workflowRuns)
    .set({ status: "failed", updatedAt: new Date() })
    .where(eq(workflowRuns.id, run.id));
  await closeRunContainer(run, reason);
  log.warn(
    { runId: run.id, container: run.parentTaskId, reason },
    "workflow run failed on step error",
  );
}

// Read the head's verdict for a completed gate task. The dispatcher records
// it as an `agent_action_emitted` task_event (actionType GATE_VERDICT) with
// the parsed body under `actionPayload`. Fail-safe: a missing or invalid
// verdict returns "fail" so an unreviewed piece never advances toward
// publish (mirrors the head-review parseVerdict default-to-reject).
async function loadGateVerdict(
  gateTaskId: string,
): Promise<"go" | "fail" | "kill"> {
  const [row] = await db
    .select({ payload: taskEvents.payload })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, gateTaskId),
        eq(taskEvents.eventType, "agent_action_emitted"),
        sql`${taskEvents.payload}->>'actionType' = 'GATE_VERDICT'`,
        sql`${taskEvents.payload}->'actionPayload'->>'verdict' IN ('go','fail','kill')`,
      ),
    )
    .orderBy(desc(taskEvents.sequence))
    .limit(1);
  const verdict = (
    row?.payload as { actionPayload?: { verdict?: string } } | undefined
  )?.actionPayload?.verdict;
  if (verdict === "go" || verdict === "kill") return verdict;
  if (verdict !== "fail") {
    log.warn(
      { gateTaskId, verdict: verdict ?? null },
      "gate task has no valid GATE_VERDICT; defaulting to fail",
    );
  }
  return "fail";
}

// The deliverable of the latest done step task at `stepIndex` for this run.
// Used to carry the actual article forward on GO (the verified piece the
// gate reviewed) and back on FAIL (the draft being revised) — the gate's own
// output is the head's decision prose, not the article.
async function loadDoneStepOutput(
  runId: string,
  stepIndex: number,
): Promise<string> {
  if (stepIndex < 0) return "";
  const [row] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.workflowRunId, runId),
        eq(tasks.workflowStepIndex, stepIndex),
        eq(tasks.status, "done"),
      ),
    )
    .orderBy(desc(tasks.updatedAt))
    .limit(1);
  return row ? loadStepOutputText(row.id) : "";
}

// Document references for every prior step of this run, so a later step can
// pull the FULL earlier deliverable on demand instead of having all of them
// dumped into its prompt. One entry per step (latest doc, so a revised step
// points at its newest version). The agent fetches a doc by id through its
// documents tool (`/api/me/agent/documents/:id`).
async function loadPriorStepDocRefs(
  runId: string,
  beforeIndex: number,
): Promise<Array<{ stepIndex: number; title: string; docId: string }>> {
  const rows = await db
    .select({
      stepIndex: tasks.workflowStepIndex,
      title: tasks.title,
      docId: documents.id,
    })
    .from(tasks)
    .innerJoin(documents, eq(documents.taskId, tasks.id))
    .where(
      and(
        eq(tasks.workflowRunId, runId),
        eq(tasks.status, "done"),
        sql`${tasks.workflowStepIndex} IS NOT NULL`,
        sql`${tasks.workflowStepIndex} < ${beforeIndex}`,
      ),
    )
    .orderBy(asc(tasks.workflowStepIndex), desc(documents.createdAt));
  const seen = new Set<number>();
  const out: Array<{ stepIndex: number; title: string; docId: string }> = [];
  for (const r of rows) {
    if (r.stepIndex == null || seen.has(r.stepIndex)) continue;
    seen.add(r.stepIndex);
    out.push({ stepIndex: r.stepIndex, title: r.title, docId: r.docId });
  }
  return out;
}

// Default input payload for a tool step: the carried deliverable as `content`.
// Tool-agnostic by design — the engine knows nothing about any specific tool's
// shape. A step's `input` map (resolved from YAML) is merged ON TOP of this, so
// authors add or override fields per tool (title, image_url, format, …) without
// the engine carrying tool-specific branches. Per-tool normalization (e.g.
// publish deriving a title from the article heading) lives in that tool's
// handler, not here.
function buildToolInput(content: string): Record<string, unknown> {
  return { content };
}

// Persist a completed step's output under its `id` so a later tool step's
// `input` can reference it. No-op for steps without an id (not referenceable).
// jsonb-merges so concurrent/sequential step writes accumulate.
async function recordStepOutput(
  runId: string,
  stepId: string | undefined,
  value: unknown,
): Promise<void> {
  if (!stepId) return;
  await db
    .update(workflowRuns)
    .set({
      stepOutputs: sql`${workflowRuns.stepOutputs} || ${JSON.stringify({ [stepId]: value })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(workflowRuns.id, runId));
}

// Resolve a tool step's `input` map against the run's stored step outputs.
// `{{id.output}}` → the stored output stringified; `{{id.output.field}}` → a
// field of a stored object output (e.g. a generated image url). Missing refs
// resolve to empty string (validation already guarantees the id exists; an
// empty value means that step produced nothing referenceable at run time).
async function resolveToolInput(
  runId: string,
  inputMap: Record<string, string>,
): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ stepOutputs: workflowRuns.stepOutputs })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .limit(1);
  const outputs = (row?.stepOutputs ?? {}) as Record<string, unknown>;
  const lookup = (id: string, field?: string): string => {
    const out = outputs[id];
    if (field) {
      const f =
        out && typeof out === "object"
          ? (out as Record<string, unknown>)[field]
          : undefined;
      return f == null ? "" : String(f);
    }
    if (out == null) return "";
    return typeof out === "string" ? out : JSON.stringify(out);
  };
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputMap)) {
    const out = resolveOutputRefs(value, lookup);
    // A value that resolved to empty means a referenced step produced nothing
    // (e.g. an image step that failed). Omit the key rather than pass "" — the
    // tool sees an absent optional field and degrades gracefully (publish ships
    // the article without a cover image instead of failing url validation).
    if (out !== "") resolved[key] = out;
  }
  return resolved;
}

// Deterministic tool step. The engine does NOT spawn a task: it resolves the
// deployment from `assigned_to`, looks up the company tool by type, and invokes
// its action AS that role with the carried deliverable. A URL in the result is
// recorded as the run container's result_uri (Provenance / on-chain anchor read
// it there). No agent free-improv, no token spend. A "ToolStep" task event
// captures the outcome either way. Publishing is just `tool: publish`.
async function executeToolStep(
  run: WorkflowRunRow,
  definition: WorkflowDefinition,
  stepIndex: number,
  content: string,
): Promise<void> {
  const step = definition.steps[stepIndex];
  if (
    !step ||
    !isSpawnStep(step) ||
    step.kind !== "tool" ||
    !step.tool ||
    !step.action ||
    !run.parentTaskId
  ) {
    return;
  }
  const container = run.parentTaskId;
  const toolType = step.tool;
  const actionName = step.action;

  const emit = (payload: Record<string, unknown>): void =>
    void appendTaskEventBestEffort({
      companyId: run.companyId,
      taskId: container,
      eventType: "agent_action_emitted",
      actorType: "system",
      actorId: "system",
      payload: {
        actionType: "ToolStep",
        channel: "system",
        tool: toolType,
        action: actionName,
        ...payload,
      },
    });

  const deploymentId = await resolveAssignedDeployment(
    run.companyId,
    step.assigned_to,
  );
  const [toolRow] = await db
    .select({ id: companyTools.id })
    .from(companyTools)
    .where(
      and(
        eq(companyTools.companyId, run.companyId),
        eq(companyTools.type, toolType),
        eq(companyTools.status, "active"),
      ),
    )
    .limit(1);

  if (!toolRow) {
    log.warn({ runId: run.id, toolType }, "tool step: tool not installed/active");
    emit({ outcome: "failed", reason: "tool_not_installed" });
    return;
  }
  if (!deploymentId) {
    log.warn(
      { runId: run.id, assignedTo: step.assigned_to },
      "tool step: role did not resolve",
    );
    emit({ outcome: "failed", reason: "role_unresolved" });
    return;
  }
  if (!content.trim()) {
    emit({ outcome: "failed", reason: "empty_input" });
    return;
  }

  // Default input from the carried deliverable, with the step's explicit
  // `input` map (resolved against prior step outputs) merged on top.
  const input = {
    ...buildToolInput(content),
    ...(step.input ? await resolveToolInput(run.id, step.input) : {}),
  };

  const outcome = await invokeTool({
    toolId: toolRow.id,
    actionName,
    companyId: run.companyId,
    deploymentId,
    input,
  });

  if (outcome.kind !== "ok") {
    const reason =
      outcome.kind === "failed"
        ? outcome.errorMessage
        : String(outcome.reason);
    log.warn(
      { runId: run.id, toolType, actionName, kind: outcome.kind, reason },
      "tool step: failed",
    );
    emit({ outcome: "failed", reason });
    return;
  }

  // Store this tool step's JSON output so a later step's `input` can reference
  // it (e.g. {{cover_image.output.url}} flowing into the publish step).
  await recordStepOutput(run.id, step.id, outcome.output ?? null);

  const url = (outcome.output as { url?: string } | null)?.url ?? "";
  if (url) {
    await db
      .update(tasks)
      .set({ resultUri: url, updatedAt: new Date() })
      .where(eq(tasks.id, container));
  }
  emit({ outcome: "ok", ...(url ? { url } : {}) });
  log.info(
    { runId: run.id, toolType, actionName, url },
    "tool step executed",
  );
}

// Advance into `startIndex` (CAS on the prior cursor) and run every tool step
// from there inline — a tool step is engine-executed, not spawned, so the
// pipeline flows through a run of them without waiting. Stops at the first
// non-tool step (spawns it and returns) or ends the run when the tool run
// reaches the end. Shared by the normal advance and the gate-GO advance.
async function runToolStepsFrom(
  run: WorkflowRunRow,
  definition: WorkflowDefinition,
  startIndex: number,
  fromCursor: number,
  content: string,
  parentTitle: string,
): Promise<{ spawned: number }> {
  const advanced = await db
    .update(workflowRuns)
    .set({ currentStepIndex: startIndex, updatedAt: new Date() })
    .where(
      and(
        eq(workflowRuns.id, run.id),
        eq(workflowRuns.currentStepIndex, fromCursor),
      ),
    )
    .returning({ id: workflowRuns.id });
  if (advanced.length === 0) {
    log.info({ runId: run.id }, "tool step: cursor moved concurrently; skip");
    return { spawned: 0 };
  }

  for (let index = startIndex; index < definition.steps.length; index++) {
    if (index !== startIndex) {
      await db
        .update(workflowRuns)
        .set({ currentStepIndex: index, updatedAt: new Date() })
        .where(eq(workflowRuns.id, run.id));
    }
    const step = definition.steps[index];
    if (step && isSpawnStep(step) && step.kind === "tool") {
      await executeToolStep(run, definition, index, content);
      continue;
    }
    // First non-tool step after the tool run — spawn it carrying the same
    // deliverable, then wait for its completion to drive the next advance.
    const spawnedId = await spawnSequentialStep(
      { ...run, currentStepIndex: index },
      definition,
      index,
      parentTitle,
      contextBlock("Input from the previous step:", content),
    );
    log.info(
      { runId: run.id, stepIndex: index, spawnedTaskId: spawnedId },
      "tool run: spawned next step",
    );
    return { spawned: spawnedId ? 1 : 0 };
  }
  await finishRun(run, "workflow_run_complete");
  return { spawned: 0 };
}

// Gate completion handler. Reads the head's verdict and either advances past
// the gate (go), bounces back to the draft step for revision (fail), or kills
// the run (kill / revise cap reached). The draft sits two steps before the
// gate in the news pipeline (draft → verify → gate are adjacent), so FAIL
// rewinds the cursor by two and re-runs draft → verify → gate.
async function advanceGateStep(
  run: WorkflowRunRow,
  definition: WorkflowDefinition,
  gateTaskId: string,
): Promise<{ spawned: number }> {
  const gateIndex = run.currentStepIndex;
  const verdict = await loadGateVerdict(gateTaskId);
  const parentTitle = run.parentTaskId
    ? await loadTaskTitle(run.parentTaskId)
    : "";
  const signoff = await loadStepOutputText(gateTaskId);

  if (verdict === "kill") {
    await killRun(run, "gate_kill");
    return { spawned: 0 };
  }

  if (verdict === "go") {
    const nextIndex = gateIndex + 1;
    if (nextIndex >= definition.steps.length) {
      await finishRun(run, "workflow_run_complete");
      return { spawned: 0 };
    }
    const article = await loadDoneStepOutput(run.id, gateIndex - 1);

    // Gate clears straight into a tool step (no content step in between): run
    // the tool(s) inline as the assigned role.
    const nextStep = definition.steps[nextIndex];
    if (nextStep && isSpawnStep(nextStep) && nextStep.kind === "tool") {
      return runToolStepsFrom(
        run,
        definition,
        nextIndex,
        gateIndex,
        article,
        parentTitle,
      );
    }

    const advanced = await db
      .update(workflowRuns)
      .set({ currentStepIndex: nextIndex, updatedAt: new Date() })
      .where(
        and(
          eq(workflowRuns.id, run.id),
          eq(workflowRuns.currentStepIndex, gateIndex),
        ),
      )
      .returning({ id: workflowRuns.id });
    if (advanced.length === 0) {
      log.info({ runId: run.id }, "gate go: cursor moved concurrently; skip");
      return { spawned: 0 };
    }
    const spawnedId = await spawnSequentialStep(
      { ...run, currentStepIndex: nextIndex },
      definition,
      nextIndex,
      parentTitle,
      [
        ...contextBlock("Output that passed the gate:", article),
        ...contextBlock("Gate sign-off notes:", signoff),
      ],
    );
    log.info(
      { runId: run.id, stepIndex: nextIndex, spawnedTaskId: spawnedId },
      "gate go: advanced",
    );
    return { spawned: spawnedId ? 1 : 0 };
  }

  // verdict === "fail" — bounce to the draft step, capped so a piece can't
  // loop forever. At the cap the engine force-kills the run.
  const cap = definition.caps?.max_revisions ?? DEFAULT_MAX_REVISIONS;
  if (run.reviseCount >= cap) {
    log.warn(
      { runId: run.id, reviseCount: run.reviseCount, cap },
      "gate fail: revise cap reached, killing run",
    );
    await killRun(run, "gate_revise_cap");
    return { spawned: 0 };
  }
  // Bounce target: the gate's explicit `on_fail_goto` (a step id), else the
  // legacy two-steps-back default. Re-runs the pipeline from there.
  const gateStep = definition.steps[gateIndex];
  const targetId =
    gateStep && isSpawnStep(gateStep) ? gateStep.on_fail_goto : undefined;
  const byId = targetId
    ? definition.steps.findIndex((s) => isSpawnStep(s) && s.id === targetId)
    : -1;
  const draftIndex = byId >= 0 ? byId : Math.max(0, gateIndex - 2);
  const updated = await db
    .update(workflowRuns)
    .set({
      currentStepIndex: draftIndex,
      reviseCount: run.reviseCount + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workflowRuns.id, run.id),
        eq(workflowRuns.currentStepIndex, gateIndex),
      ),
    )
    .returning({ id: workflowRuns.id });
  if (updated.length === 0) {
    log.info({ runId: run.id }, "gate fail: cursor moved concurrently; skip");
    return { spawned: 0 };
  }
  const priorDraft = await loadDoneStepOutput(run.id, draftIndex);
  const spawnedId = await spawnSequentialStep(
    { ...run, currentStepIndex: draftIndex, reviseCount: run.reviseCount + 1 },
    definition,
    draftIndex,
    parentTitle,
    [
      ...contextBlock(
        "Your prior output (returned by the gate for revision):",
        priorDraft,
      ),
      ...contextBlock("Revision notes from the gate — address these:", signoff),
    ],
  );
  log.info(
    {
      runId: run.id,
      draftIndex,
      reviseCount: run.reviseCount + 1,
      spawnedTaskId: spawnedId,
    },
    "gate fail: bounced to draft",
  );
  return { spawned: spawnedId ? 1 : 0 };
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
      reviseCount: workflowRuns.reviseCount,
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

  // Gate step: the head's GATE_VERDICT decides advance / re-draft / kill,
  // instead of the plain cursor+1. Reads the verdict the dispatcher recorded
  // on the gate task's completion; never advances toward publish on a
  // missing/invalid verdict (fail-safe FAIL).
  const completedStep = wf.definition.steps[run.currentStepIndex];

  // Persist this step's deliverable under its id so a later tool step's
  // `input` can reference it (e.g. publish pulling {{seo.output}}). Runs for
  // every completed spawn/gate step before any branch, including the path
  // into the gate handler.
  if (completedStep && isSpawnStep(completedStep) && completedStep.id) {
    await recordStepOutput(
      run.id,
      completedStep.id,
      await loadStepOutputText(completed.id),
    );
  }

  if (
    completedStep &&
    isSpawnStep(completedStep) &&
    completedStep.kind === "gate"
  ) {
    return advanceGateStep(run, wf.definition, completed.id);
  }

  const nextIndex = run.currentStepIndex + 1;
  if (nextIndex >= wf.definition.steps.length) {
    await finishRun(run, "workflow_run_complete");
    return { spawned: 0 };
  }

  const parentTitle = run.parentTaskId
    ? await loadTaskTitle(run.parentTaskId)
    : "";
  // The just-completed step's deliverable — carried into the next step, or
  // published verbatim when the next step is the terminal publish step.
  const prevOutput = await loadStepOutputText(completed.id);

  // Tool step next: the engine runs it (and any following tool steps) inline
  // — invokes the tool as the assigned role, no task spawned.
  const nextStep = wf.definition.steps[nextIndex];
  if (nextStep && isSpawnStep(nextStep) && nextStep.kind === "tool") {
    return runToolStepsFrom(
      run,
      wf.definition,
      nextIndex,
      run.currentStepIndex,
      prevOutput,
      parentTitle,
    );
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
  // Carry the just-completed step's deliverable into the next step so the
  // pipeline flows (brief → draft → verify) instead of each step starting
  // blind.
  const prevStep = wf.definition.steps[run.currentStepIndex];
  const prevLabel =
    prevStep && isSpawnStep(prevStep)
      ? `Input from the previous step (${renderTitle(prevStep.title, parentTitle)}):`
      : "Input from the previous step:";
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

// A workflow step task errored (parked after its retries were exhausted).
// Mirror of advanceWorkflowRun for the failure case: skip past the step if its
// policy allows, else fail the whole run so it can't stall "In Progress".
async function handleWorkflowStepError(errored: {
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
      reviseCount: workflowRuns.reviseCount,
    })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, errored.workflowRunId))
    .limit(1);
  if (!run || run.status !== "running") return { spawned: 0 };
  // Only the errored step still sitting at the cursor matters — a stale/dup
  // event, or a step since retried to done and advanced, is a no-op.
  if (
    errored.workflowStepIndex == null ||
    errored.workflowStepIndex !== run.currentStepIndex
  ) {
    return { spawned: 0 };
  }

  const wf = await loadEnabledWorkflowByYamlId(run.companyId, run.workflowYamlId);
  if (!wf) return { spawned: 0 };

  const erroredStep = wf.definition.steps[run.currentStepIndex];
  // Default to `retry`: salvage a flaky step (up to the cap) before giving up,
  // rather than failing the whole run on the first error. `fail_run`/`skip` are
  // explicit opt-ins per step.
  const policy =
    (erroredStep && isSpawnStep(erroredStep) ? erroredStep.on_error : undefined) ??
    "retry";
  const title =
    erroredStep && isSpawnStep(erroredStep) ? erroredStep.title : "step";

  // retry: resume the SAME errored task rather than spawning a fresh one. The
  // dispatcher keys the agent session by task id, so re-dispatching this exact
  // task lands on the same session and claude `--resume` continues the prior
  // transcript instead of re-paying the full prompt. A new task would mint a
  // new session key and throw the interrupted work (and its cost) away.
  if (policy === "retry") {
    // Atomic claim: flip the errored task back to `todo` and bump its retry
    // counter in one write. The `status = 'error'` guard makes this the dedup —
    // a duplicate/late error event (or a sibling already retried to done) finds
    // no row to claim and no-ops, so the step can't be re-dispatched twice. The
    // dispatcher clears errorCode + sets in_progress when it picks the job up.
    const claimed = await db
      .update(tasks)
      .set({
        status: "todo",
        retryCount: sql`${tasks.retryCount} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, errored.id), eq(tasks.status, "error")))
      .returning({ retryCount: tasks.retryCount });
    if (claimed.length === 0) return { spawned: 0 };

    const attempt = claimed[0]?.retryCount ?? 0;
    if (attempt > MAX_STEP_RETRIES) {
      // Out of retries — revert to `error` so the failed step stays the board's
      // visible failure record (errorCode is untouched), then fail the run.
      await db
        .update(tasks)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(tasks.id, errored.id));
      await failRun(run, `step_error_retries_exhausted:${title}`);
      return { spawned: 0 };
    }

    void enqueueTaskDispatch(errored.id, { dedupe: false }).catch((err) =>
      log.error(
        { err, taskId: errored.id },
        "workflow step retry re-dispatch enqueue failed",
      ),
    );
    log.warn(
      { runId: run.id, stepIndex: run.currentStepIndex, taskId: errored.id, attempt },
      "workflow step errored; resuming same task (retry)",
    );
    return { spawned: 1 };
  }

  // Default (fail_run): a critical step died — fail the run rather than freeze it.
  if (policy !== "skip") {
    await failRun(run, `step_error:${title}`);
    return { spawned: 0 };
  }

  // skip: advance past the errored step. Its output is NOT recorded, so a later
  // `{{<id>.output}}` reference resolves empty and degrades gracefully (e.g. a
  // publish step ships without the missing image). Carry the last good
  // deliverable forward as context.
  const nextIndex = run.currentStepIndex + 1;
  const parentTitle = run.parentTaskId
    ? await loadTaskTitle(run.parentTaskId)
    : "";
  const carry = await loadDoneStepOutput(run.id, run.currentStepIndex - 1);

  if (nextIndex >= wf.definition.steps.length) {
    await finishRun(run, "workflow_run_complete_after_skip");
    return { spawned: 0 };
  }

  const nextStep = wf.definition.steps[nextIndex];
  if (nextStep && isSpawnStep(nextStep) && nextStep.kind === "tool") {
    return runToolStepsFrom(
      run,
      wf.definition,
      nextIndex,
      run.currentStepIndex,
      carry,
      parentTitle,
    );
  }

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
  if (updated.length === 0) return { spawned: 0 };

  const spawnedId = await spawnSequentialStep(
    { ...run },
    wf.definition,
    nextIndex,
    parentTitle,
    contextBlock("Input from the previous step:", carry),
  );
  log.info(
    { runId: run.id, skippedStepIndex: run.currentStepIndex, nextIndex },
    "workflow run skipped errored step",
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
      status: tasks.status,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (stepRow?.workflowRunId) {
    // A step that errored (vs completed) takes the failure path: skip the step
    // or fail the run per its on_error policy, so the run never stalls.
    const adv =
      stepRow.status === "error"
        ? await handleWorkflowStepError({
            id: taskId,
            workflowRunId: stepRow.workflowRunId,
            workflowStepIndex: stepRow.workflowStepIndex,
          })
        : await advanceWorkflowRun({
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

  // A non-workflow task that errored has nothing to fan out — only `done`
  // tasks drive task_type matching. (The poller now also fires on `error`.)
  if (stepRow?.status === "error") {
    return { evaluated: 0, spawnedTotal: 0, skippedAlreadyEvaluated: 0 };
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
