import { and, eq, inArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "../infra/database/client";
import { AGENT_WAIT_TIMEOUT_MS, TRACE_EVENT_FLUSH_MS } from "../lib/timing";
import {
  agents,
  approvals,
  tasks,
  traces,
  traceEvents,
} from "@occa/shared/schema";
import type { ContentBlock, TaskStatus } from "@occa/shared/types";
import {
  extractActionBlocks,
  hasOccaMarker,
  stripOccaMarkers,
  type OccaActionBlock,
} from "@occa/shared/markers";
import { publishTraceEvent } from "./trace-events-bus";
import { canHire, listSubordinates } from "../features/agents/services/agent-hierarchy";
import { cascadeOnTaskDone } from "./task-cascade";
import { createTaskComment } from "./task-comments";
import { getAdapter } from "../lib/adapter-registry";
import { childLogger } from "../lib/logger";

const log = childLogger("task-dispatcher");

// ── Prompt builder ────────────────────────────────────────────────────────────

function blocksToMarkdown(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case "heading_1":
          return `# ${b.text}`;
        case "heading_2":
          return `## ${b.text}`;
        case "heading_3":
          return `### ${b.text}`;
        case "bullet":
          return `- ${b.text}`;
        case "checklist":
          return `- [${b.checked ? "x" : " "}] ${b.text}`;
        case "quote":
          return `> ${b.text}`;
        case "code":
          return `\`\`\`\n${b.text}\n\`\`\``;
        case "divider":
          return "---";
        case "paragraph":
          return b.text;
        case "agent_result":
          return ""; // skip prior outputs
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

interface SubordinateRef {
  id: string;
  name: string;
  role: string;
}

// Roles an agent may HIRE — mirrors the canonical catalog in @occa/shared.
// Used to render the prompt block telling the agent what it can spawn, so
// the LLM only ever picks from valid catalog slugs.
import { ROLE_ORDER as SHARED_ROLE_ORDER } from "@occa/shared";
const HIRE_ROLE_CATALOG: readonly string[] = SHARED_ROLE_ORDER;

function renderReportsBlock(reports: SubordinateRef[]): string {
  if (reports.length === 0) {
    return [
      `Available reports (DELEGATE): none.`,
      `You have no agents reporting to you yet. If the task needs another`,
      `role, request a HIRE — see the OCCA Runtime skill for the API.`,
    ].join("\n");
  }
  const lines = [
    `Available reports (DELEGATE — assign work to an existing teammate):`,
  ];
  for (const r of reports) {
    lines.push(`  - ${r.name} (role: ${r.role}, id: ${r.id})`);
  }
  return lines.join("\n");
}

function renderHireCatalogBlock(): string {
  return [
    `Roles you may HIRE (bring on a new agent):`,
    `  ${HIRE_ROLE_CATALOG.join(", ")}`,
    `New hires become your direct reports and start work immediately.`,
  ].join("\n");
}

interface CompletedChildRef {
  taskNumber: number;
  title: string;
  agentName: string | null;
  resultPreview: string | null;
}

// Children of `parentTaskId` that completed since the parent was last
// dispatched. Used to populate the "Recent activity" prompt block when
// the parent agent is woken via L2 cascade — they need to see what their
// reports just shipped to decide what's next.
async function loadCompletedChildren(
  parentTaskId: string,
): Promise<CompletedChildRef[]> {
  const rows = await db
    .select({
      taskNumber: tasks.taskNumber,
      title: tasks.title,
      blocks: tasks.blocks,
      assignedAgentId: tasks.assignedAgentId,
    })
    .from(tasks)
    .where(and(eq(tasks.parentTaskId, parentTaskId), eq(tasks.status, "done")));

  if (rows.length === 0) return [];

  const agentIds = Array.from(
    new Set(
      rows
        .map((r) => r.assignedAgentId)
        .filter((id): id is string => id !== null),
    ),
  );
  const agentMap = new Map<string, string>();
  if (agentIds.length > 0) {
    const fetched = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, agentIds));
    for (const a of fetched) agentMap.set(a.id, a.name);
  }

  return rows.map((r) => {
    const blocks = (r.blocks as ContentBlock[]) ?? [];
    const result = blocks.find((b) => b.type === "agent_result");
    const preview =
      result && result.type === "agent_result" ? result.preview : null;
    return {
      taskNumber: r.taskNumber,
      title: r.title,
      agentName: r.assignedAgentId
        ? (agentMap.get(r.assignedAgentId) ?? null)
        : null,
      resultPreview: preview,
    };
  });
}

function renderCompletedChildrenBlock(children: CompletedChildRef[]): string {
  if (children.length === 0) return "";
  const lines = [
    `RECENT ACTIVITY — child tasks that completed since you last looked:`,
    ``,
  ];
  for (const c of children) {
    const who = c.agentName ?? "agent";
    lines.push(`  • Task #${c.taskNumber} "${c.title}" — completed by ${who}`);
    if (c.resultPreview) {
      const trimmed = c.resultPreview.slice(0, 280).replace(/\n/g, " ");
      lines.push(
        `      result: ${trimmed}${c.resultPreview.length > 280 ? "…" : ""}`,
      );
    }
  }
  lines.push(
    ``,
    `Synthesize what they shipped. If the parent task is now satisfied,`,
    `produce the closing summary and let the task auto-close. If more work`,
    `is needed, request another DELEGATE/HIRE.`,
  );
  return lines.join("\n");
}

async function buildTaskPrompt(
  task: typeof tasks.$inferSelect,
  agent: typeof agents.$inferSelect,
  traceId: string,
): Promise<string> {
  const cfg = (agent.adapterConfig ?? {}) as Record<string, unknown>;
  const body = blocksToMarkdown((task.blocks ?? []) as ContentBlock[]);
  const reports = await listSubordinates(agent.id);
  const completedChildren = await loadCompletedChildren(task.id);
  const acceptance = task.acceptanceCriteria
    ? [``, `Acceptance criteria: ${task.acceptanceCriteria}`]
    : [];

  return [
    `<occa-runtime>`,
    `You are running inside OCCA OS as agent "${agent.name}" (role: ${agent.role}).`,
    `Trace ID: ${traceId}`,
    `Task #${task.taskNumber} — "${task.title}"`,
    `Priority: ${task.priority} · Type: ${task.taskType} · Effort: ${task.effortLevel}`,
    ``,
    `INSTRUCTIONS:`,
    `- Work on the task described below and respond with your findings or result.`,
    `- If the task requires human review before being closed, end your reply with: [[OCCA:REVIEW]]`,
    `- Otherwise your reply will automatically mark the task as done.`,
    `- If you can't finish solo, emit ONE of these BLOCK MARKERS in your`,
    `  reply (the server parses the JSON body and acts on it):`,
    ``,
    `    [[OCCA:HIRE]]`,
    `    {`,
    `      "targetRole": "<one of: ${HIRE_ROLE_CATALOG.join(", ")}>",`,
    `      "targetName": "<a name for the new agent, e.g. Aria>",`,
    `      "title": "<short task title for their first assignment>",`,
    `      "description": "<full detail of what they should do>",`,
    `      "acceptanceCriteria": "<optional: what 'done' looks like>"`,
    `    }`,
    `    [[/OCCA:HIRE]]`,
    ``,
    `    [[OCCA:DELEGATE]]`,
    `    {`,
    `      "targetAgentId": "<uuid from 'Available reports' below>",`,
    `      "title": "<short task title>",`,
    `      "description": "<full detail>",`,
    `      "acceptanceCriteria": "<optional>"`,
    `    }`,
    `    [[/OCCA:DELEGATE]]`,
    ``,
    `    [[OCCA:BLOCK]]`,
    `    {`,
    `      "blockedByTaskIds": ["<task uuid>", "..."],`,
    `      "reason": "<short why-blocked, posted to the task's comment thread>"`,
    `    }`,
    `    [[/OCCA:BLOCK]]`,
    ``,
    `    [[OCCA:ASK]]`,
    `    {`,
    `      "question": "<what you need to know>",`,
    `      "mentionAgentId": "<optional uuid from Available reports>"`,
    `    }`,
    `    [[/OCCA:ASK]]`,
    ``,
    `  When to use which:`,
    `    HIRE     — no one on the team has the role you need.`,
    `    DELEGATE — someone in Available reports can do the job.`,
    `    BLOCK    — you're waiting on other tasks to complete first.`,
    `    ASK      — you're stuck and need a question answered. Mention a`,
    `               specific agent if you know who to ask; the server wakes`,
    `               them on this task. Otherwise the human answers.`,
    `  Emit at most ONE such block per turn. The block can sit anywhere in`,
    `  your reply — the server parses + strips it before persisting.`,
    `- Do not add meta-commentary — focus on the task deliverable.`,
    ``,
    renderReportsBlock(reports),
    ``,
    renderHireCatalogBlock(),
    ``,
    // Empty when this is a fresh dispatch with no completed children;
    // populated when L2 cascade re-wakes the parent after children
    // finish. The agent reads this to decide whether to close or keep
    // delegating.
    ...(completedChildren.length > 0
      ? [renderCompletedChildrenBlock(completedChildren), ``]
      : []),
    `API base: ${typeof cfg.gatewayUrl === "string" ? cfg.gatewayUrl : "unknown"}`,
    `</occa-runtime>`,
    ``,
    `<task>`,
    `# ${task.title}`,
    body,
    ...acceptance,
    `</task>`,
  ].join("\n");
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export async function dispatchTask(taskId: string): Promise<void> {
  // Load task + agent in one go.
  const [taskRow] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (!taskRow?.assignedAgentId) return;

  // Defense-in-depth: even if two queue jobs somehow slip past the
  // `exclusive` policy, refuse to launch a second dispatcher for a task
  // already being worked on.
  if (taskRow.status === "in_progress" && taskRow.linkedTraceId) {
    log.warn(
      `[dispatcher] task ${taskId} already in_progress (trace=${taskRow.linkedTraceId}), skipping`,
    );
    return;
  }

  const [agentRow] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.id, taskRow.assignedAgentId),
        eq(agents.companyId, taskRow.companyId),
      ),
    )
    .limit(1);

  if (!agentRow) return;

  const adapter = getAdapter(agentRow.adapterType);
  if (!adapter) {
    log.warn(
      `[task-dispatcher] unknown adapter type "${agentRow.adapterType}" for agent ${agentRow.id}, skipping dispatch`,
    );
    return;
  }

  if (!agentRow.externalAgentId) {
    log.warn(
      `[task-dispatcher] agent ${agentRow.id} not fully configured (missing externalAgentId), skipping dispatch`,
    );
    return;
  }

  const cfg = (agentRow.adapterConfig ?? {}) as Record<string, unknown>;

  // Create trace row.
  const now = new Date();
  const traceId = uuid();
  await db.insert(traces).values({
    id: traceId,
    companyId: taskRow.companyId,
    agentId: agentRow.id,
    taskId: taskRow.id,
    invocationSource: "task",
    conversationId: taskRow.id, // task id doubles as conversation anchor
    actorType: "user",
    actorId: taskRow.createdByUserId,
    status: "running",
    startedAt: now,
  });

  // Mark task in_progress.
  await db
    .update(tasks)
    .set({ status: "in_progress", linkedTraceId: traceId, updatedAt: now })
    .where(eq(tasks.id, taskRow.id));

  // Emit lifecycle started to any live SSE subscribers.
  publishTraceEvent(traceId, {
    seq: 0,
    eventType: "lifecycle",
    phase: "started",
    taskStatus: "in_progress",
    createdAt: now.toISOString(),
  });

  const message = await buildTaskPrompt(taskRow, agentRow, traceId);
  const sessionKey = `agent:${agentRow.externalAgentId}:task:${traceId}`;

  // Persist events in batches — bus publish is instant, DB write is batched.
  // `seqRef.current` is the next-seq cursor; using a shared ref so helpers
  // (e.g. processActionBlock) can advance the same counter we use here.
  // Bug fix: previously this was a local `let seq` and the helper got a
  // copy — its increments were lost, causing duplicate "lifecycle-N" keys
  // in the live trace UI when an approval block was emitted.
  const seqRef = { current: 1 }; // 0 reserved for the lifecycle "started" above.
  const pending: Array<typeof traceEvents.$inferInsert> = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    flushTimer = null;
    if (!pending.length) return;
    const batch = pending.splice(0);
    try {
      await db.insert(traceEvents).values(batch);
    } catch {
      /* ignore */
    }
  };

  const queueEvent = (stream: string, payload: Record<string, unknown>) => {
    const mySeq = seqRef.current++;
    const createdAt = new Date().toISOString();
    pending.push({
      companyId: taskRow.companyId,
      traceId,
      agentId: agentRow.id,
      seq: mySeq,
      eventType: "stream",
      stream,
      payload,
    });
    if (!flushTimer) flushTimer = setTimeout(() => void flush(), TRACE_EVENT_FLUSH_MS);
    publishTraceEvent(traceId, {
      seq: mySeq,
      eventType: "stream",
      stream,
      payload,
      createdAt,
    });
  };

  // Fire prompt — this awaits agent reply (can take minutes).
  const result = await adapter.sendPrompt({
    adapterConfig: cfg,
    externalAgentId: agentRow.externalAgentId,
    sessionKey,
    message,
    onEvent: (stream, data) => queueEvent(stream, data),
    waitTimeoutMs: AGENT_WAIT_TIMEOUT_MS,
  });

  if (flushTimer) clearTimeout(flushTimer);
  await flush();

  const finishedAt = new Date();

  if (!result.ok) {
    await db
      .update(traces)
      .set({
        status: "failed",
        finishedAt,
        error: result.reason ?? result.error,
        errorCode: result.error,
        updatedAt: finishedAt,
      })
      .where(eq(traces.id, traceId));

    // Revert task to todo so user can retry.
    await db
      .update(tasks)
      .set({ status: "todo", linkedTraceId: null, updatedAt: finishedAt })
      .where(eq(tasks.id, taskRow.id));

    publishTraceEvent(traceId, {
      seq: seqRef.current++,
      eventType: "lifecycle",
      phase: "failed",
      taskStatus: "todo",
      error: result.reason ?? result.error,
      createdAt: finishedAt.toISOString(),
    });
    return;
  }

  // Detect control markers first, then strip them — the persisted reply must
  // never contain OCCA:* markers; those are backend-only signaling tokens.
  const needsReview = hasOccaMarker(result.reply, "REVIEW");

  // Block markers — `[[OCCA:HIRE]] {...} [[/OCCA:HIRE]]` and DELEGATE.
  // Each valid block creates a pending approval row server-side, mirroring
  // what would happen if the agent had POSTed to /api/agents/me/approvals.
  // Provides a reliable text-based fallback for environments where the
  // agent cannot make outbound HTTP calls.
  const actionBlocks = extractActionBlocks(result.reply);
  let approvalsRequested = 0;
  let blockedBy: string[] | null = null;
  let askPosted = false;
  for (const block of actionBlocks) {
    try {
      const outcome = await processActionBlock({
        block,
        agentId: agentRow.id,
        companyId: taskRow.companyId,
        currentTaskId: taskRow.id,
        traceId,
        seqRef,
      });
      if (outcome.kind === "approval_created") approvalsRequested += 1;
      if (outcome.kind === "ask_posted") askPosted = true;
      if (outcome.kind === "blocked") blockedBy = outcome.blockerIds;
    } catch (err) {
      log.error(
        { err },
        `[task-dispatcher] action-block processing failed token=${block.token}`,
      );
      publishTraceEvent(traceId, {
        seq: seqRef.current++,
        eventType: "lifecycle",
        phase: "action_block_failed",
        token: block.token,
        error: err instanceof Error ? err.message : "unknown",
        createdAt: new Date().toISOString(),
      });
    }
  }

  // Decide the next task status.
  //
  //   BLOCK action  → `blocked` (parked until blockers complete; cascade unblocks)
  //   REVIEW marker → `review`
  //   HIRE/DELEGATE approval pending → `review` (waiting on human decision)
  //   ASK comment posted → `review` (waiting on mentioned agent's reply)
  //   default       → `done`
  //
  // BLOCK wins over everything else — once a task declares it's waiting
  // on other tasks, no other status makes sense.
  const waitingOnApproval = approvalsRequested > 0 || askPosted;
  const nextStatus: TaskStatus = blockedBy
    ? "blocked"
    : needsReview || waitingOnApproval
      ? "review"
      : "done";

  const cleanReply = stripOccaMarkers(result.reply);
  const preview = cleanReply.slice(0, 200);

  await db
    .update(traces)
    .set({
      status: "succeeded",
      finishedAt,
      resultJson: { text: cleanReply },
      updatedAt: finishedAt,
    })
    .where(eq(traces.id, traceId));

  const agentResultBlock: ContentBlock = {
    type: "agent_result",
    traceId,
    agentId: agentRow.id,
    agentName: agentRow.name,
    timestamp: finishedAt.toISOString(),
    preview,
  };

  const currentBlocks = ((taskRow.blocks ?? []) as ContentBlock[]).filter(
    (b) => b.type !== "agent_result", // replace any prior result block
  );

  await db
    .update(tasks)
    .set({
      status: nextStatus,
      linkedTraceId: null,
      blocks: [...currentBlocks, agentResultBlock],
      // Persist the blocker list when the agent emitted a BLOCK action;
      // cascadeOnTaskDone strips entries from this list as blockers
      // complete, and re-dispatches when it reaches empty.
      ...(blockedBy ? { blockedByTaskIds: blockedBy } : {}),
      updatedAt: finishedAt,
    })
    .where(eq(tasks.id, taskRow.id));

  publishTraceEvent(traceId, {
    seq: seqRef.current++,
    eventType: "lifecycle",
    phase: "completed",
    taskStatus: nextStatus,
    createdAt: finishedAt.toISOString(),
  });

  // L2 cascade — if this task just became `done` AND has a parent, check
  // whether all siblings are also done; if yes, wake the parent agent so
  // they can synthesize the children's output. Fire-and-forget — failure
  // shouldn't break the task close path.
  if (nextStatus === "done") {
    void cascadeOnTaskDone({ taskId: taskRow.id }).catch((err) => {
      log.error({ err, taskId: taskRow.id }, "cascadeOnTaskDone failed");
    });
  }
}

// ── Action block → approval row ───────────────────────────────────────────────
//
// Validates the JSON body of a block marker, runs the same scope/role
// checks the HTTP endpoint runs, and inserts a pending approval row. The
// existing decide handler picks it up unchanged — block-driven and
// HTTP-driven submissions share the exact same downstream path.

const HIRE_ROLE_SET = new Set(HIRE_ROLE_CATALOG);

interface ProcessActionBlockArgs {
  block: OccaActionBlock;
  agentId: string;
  companyId: string;
  currentTaskId: string;
  traceId: string;
  seqRef: { current: number };
}

// Discriminated outcome — caller uses `kind` to decide the parent task's
// next status (BLOCK forces `blocked`, others force `review`, ignored
// passes through to default `done`).
type ActionBlockOutcome =
  | { kind: "ignored" }
  | { kind: "approval_created" } // HIRE / DELEGATE
  | { kind: "ask_posted" } // ASK
  | { kind: "blocked"; blockerIds: string[] };

async function processActionBlock(
  args: ProcessActionBlockArgs,
): Promise<ActionBlockOutcome> {
  const { block, agentId, companyId, currentTaskId, traceId, seqRef } = args;

  if (!block.parsed || !block.body) {
    publishTraceEvent(traceId, {
      seq: seqRef.current++,
      eventType: "lifecycle",
      phase: "action_block_invalid_json",
      token: block.token,
      createdAt: new Date().toISOString(),
    });
    return { kind: "ignored" };
  }

  const body = block.body;

  if (block.token === "HIRE") {
    const targetRole =
      typeof body.targetRole === "string" ? body.targetRole : "";
    const targetName =
      typeof body.targetName === "string" ? body.targetName.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const description =
      typeof body.description === "string" ? body.description.trim() : "";
    const acceptanceCriteria =
      typeof body.acceptanceCriteria === "string"
        ? body.acceptanceCriteria.trim()
        : undefined;

    if (!targetRole || !HIRE_ROLE_SET.has(targetRole)) {
      log.warn(
        `[task-dispatcher] HIRE block rejected: invalid role=${targetRole}`,
      );
      return { kind: "ignored" };
    }
    if (!targetName || !title || !description) {
      log.warn("HIRE block rejected: missing required fields");
      return { kind: "ignored" };
    }

    const [row] = await db
      .insert(approvals)
      .values({
        companyId,
        requestedByAgentId: agentId,
        actionType: "hire",
        payload: {
          targetRole,
          targetName,
          title,
          description,
          ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
          parentTaskId: currentTaskId,
        },
      })
      .returning({ id: approvals.id });

    publishTraceEvent(traceId, {
      seq: seqRef.current++,
      eventType: "lifecycle",
      phase: "approval_requested",
      token: "HIRE",
      approvalId: row.id,
      summary: `Hire ${targetName} (${targetRole})`,
      createdAt: new Date().toISOString(),
    });
    return { kind: "approval_created" };
  }

  if (block.token === "DELEGATE") {
    const targetAgentId =
      typeof body.targetAgentId === "string" ? body.targetAgentId : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const description =
      typeof body.description === "string" ? body.description.trim() : "";
    const acceptanceCriteria =
      typeof body.acceptanceCriteria === "string"
        ? body.acceptanceCriteria.trim()
        : undefined;

    if (!targetAgentId || !title || !description) {
      log.warn("DELEGATE block rejected: missing required fields");
      return { kind: "ignored" };
    }

    // Subtree validation — same rule the HTTP endpoint enforces.
    const check = await canHire(agentId, targetAgentId);
    if (!check.ok) {
      log.warn(
        `[task-dispatcher] DELEGATE block rejected: scope ${check.reason}`,
      );
      return { kind: "ignored" };
    }

    const [row] = await db
      .insert(approvals)
      .values({
        companyId,
        requestedByAgentId: agentId,
        actionType: "delegate",
        payload: {
          targetAgentId,
          title,
          description,
          ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
          parentTaskId: currentTaskId,
        },
      })
      .returning({ id: approvals.id });

    publishTraceEvent(traceId, {
      seq: seqRef.current++,
      eventType: "lifecycle",
      phase: "approval_requested",
      token: "DELEGATE",
      approvalId: row.id,
      summary: `Delegate to ${targetAgentId.slice(0, 8)}…`,
      createdAt: new Date().toISOString(),
    });
    return { kind: "approval_created" };
  }

  if (block.token === "BLOCK") {
    // Agent says "I can't proceed without these tasks completing first."
    // Body shape: { blockedByTaskIds: string[], reason?: string }.
    const rawIds = Array.isArray(body.blockedByTaskIds)
      ? body.blockedByTaskIds.filter((v): v is string => typeof v === "string")
      : [];
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";

    if (rawIds.length === 0) {
      log.warn("BLOCK block rejected: no blockedByTaskIds");
      return { kind: "ignored" };
    }
    if (rawIds.includes(currentTaskId)) {
      log.warn("BLOCK block rejected: cannot block on self");
      return { kind: "ignored" };
    }

    // Validate every blocker exists and is in the same company.
    const blockerRows = await db
      .select({ id: tasks.id, companyId: tasks.companyId })
      .from(tasks)
      .where(inArray(tasks.id, rawIds));
    const validIds = blockerRows
      .filter((r) => r.companyId === companyId)
      .map((r) => r.id);

    if (validIds.length === 0) {
      log.warn("BLOCK block rejected: no valid blocker ids in same company");
      return { kind: "ignored" };
    }

    // Drop reason as an audit comment if provided. Auto-attaches the
    // requester so the thread shows who blocked + why.
    if (reason) {
      try {
        await createTaskComment({
          taskId: currentTaskId,
          companyId,
          authorAgentId: agentId,
          body: `Blocked by ${validIds.length} task(s): ${reason}`,
        });
      } catch (err) {
        log.error({ err }, "BLOCK reason-comment failed");
      }
    }

    publishTraceEvent(traceId, {
      seq: seqRef.current++,
      eventType: "lifecycle",
      phase: "approval_requested",
      token: "BLOCK",
      summary: `Blocked on ${validIds.length} task(s)`,
      createdAt: new Date().toISOString(),
    });
    return { kind: "blocked", blockerIds: validIds };
  }

  if (block.token === "ASK") {
    // Agent posts a question to a teammate. Body: { question: string,
    // mentionAgentId?: string }. The mentioned agent gets woken via
    // createTaskComment's wake-on-mention machinery; if mentionAgentId
    // is omitted we still post the comment (agent flagged uncertainty
    // for the human to read).
    const question =
      typeof body.question === "string" ? body.question.trim() : "";
    const mentionAgentId =
      typeof body.mentionAgentId === "string" ? body.mentionAgentId : null;

    if (!question) {
      log.warn("ASK block rejected: empty question");
      return { kind: "ignored" };
    }

    // Compose the comment body — prefix the @mention if supplied so the
    // server's mention parser picks it up. We resolve agent name first
    // so the resulting `@<name>` is meaningful in the thread.
    let composedBody = question;
    if (mentionAgentId) {
      const [target] = await db
        .select({
          id: agents.id,
          name: agents.name,
          companyId: agents.companyId,
        })
        .from(agents)
        .where(eq(agents.id, mentionAgentId))
        .limit(1);
      if (target && target.companyId === companyId) {
        composedBody = `@${target.name} ${question}`;
      }
    }

    try {
      await createTaskComment({
        taskId: currentTaskId,
        companyId,
        authorAgentId: agentId,
        body: composedBody,
      });
    } catch (err) {
      log.error({ err }, "ASK comment insert failed");
      return { kind: "ignored" };
    }

    publishTraceEvent(traceId, {
      seq: seqRef.current++,
      eventType: "lifecycle",
      phase: "approval_requested",
      token: "ASK",
      summary: mentionAgentId
        ? `Asked ${mentionAgentId.slice(0, 8)}…`
        : "Asked the team",
      createdAt: new Date().toISOString(),
    });
    return { kind: "ask_posted" };
  }

  // Unknown block token — log and ignore.
  log.warn(
    `[task-dispatcher] unknown action block token=${block.token}, ignoring`,
  );
  return { kind: "ignored" };
}
