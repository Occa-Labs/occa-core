import { and, eq, inArray } from "drizzle-orm";
import { agents, tasks } from "@occa/shared/schema";
import type {
  ContentBlock,
  LivenessState,
  TaskStatus,
} from "@occa/shared/types";
import { db } from "./db";

// Auto-advance kanban status based on trace lifecycle:
//  - `todo` → `in_progress` when a trace starts against the task
//  - `in_progress` → `done` (or `review`) when a trace succeeds with a real reply
//  - liveness ≠ normal → stay at `in_progress`; continuation will re-trigger
//  - failed traces → status unchanged (error surfaces via notifications)
//
// On success we also append an `agent_result` block to the task body so the
// user sees inline what the agent produced. Full text stays on the trace;
// the block carries a short preview + traceId pointer for on-demand fetch.

const REVIEW_MARKER = /\[\[\s*OCCA\s*:\s*REVIEW\s*\]\]/i;
const PREVIEW_MAX_CHARS = 280;

async function loadTaskStatusAndBlocks(
  taskId: string,
): Promise<{ status: TaskStatus; blocks: ContentBlock[] } | null> {
  const [row] = await db
    .select({ status: tasks.status, blocks: tasks.blocks })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!row) return null;
  return {
    status: row.status as TaskStatus,
    blocks: (row.blocks as ContentBlock[] | null) ?? [],
  };
}

async function setTaskStatus(
  taskId: string,
  from: TaskStatus[],
  to: TaskStatus,
): Promise<boolean> {
  const res = await db
    .update(tasks)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, from)));
  // drizzle's update returns void; query rowCount via pg. But eq+inArray guards
  // idempotency — re-running is safe.
  void res;
  return true;
}

async function appendBlocks(
  taskId: string,
  blocks: ContentBlock[],
): Promise<void> {
  await db
    .update(tasks)
    .set({ blocks, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
}

export async function syncTaskOnTraceStart(
  taskId: string | null,
): Promise<void> {
  if (!taskId) return;
  const row = await loadTaskStatusAndBlocks(taskId);
  if (!row) return;
  // Kick it off the backlog/todo column once; never regress completed work.
  if (row.status === "todo") {
    await setTaskStatus(taskId, ["todo"], "in_progress");
  }
}

function extractResponseText(
  resultJson: Record<string, unknown> | null,
): string {
  if (!resultJson) return "";
  if (typeof resultJson.text === "string") return resultJson.text;
  if (typeof resultJson.message === "string") return resultJson.message;
  return "";
}

// Truncate on a word boundary so the preview doesn't chop mid-word. Also
// collapse whitespace so multi-line output reads as a single-line excerpt.
function buildPreview(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  if (flattened.length <= PREVIEW_MAX_CHARS) return flattened;
  const cut = flattened.slice(0, PREVIEW_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  const safe = lastSpace > PREVIEW_MAX_CHARS - 40 ? cut.slice(0, lastSpace) : cut;
  return `${safe}…`;
}

async function loadAgentName(agentId: string): Promise<string> {
  const [row] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return row?.name ?? "agent";
}

export async function syncTaskOnTraceSucceeded(args: {
  taskId: string | null;
  traceId: string;
  agentId: string;
  livenessState: LivenessState | null;
  resultJson: Record<string, unknown> | null;
  finishedAt: Date;
}): Promise<void> {
  if (!args.taskId) return;
  // Agent didn't actually produce a real response — leave the card alone so
  // the continuation loop can try again.
  if (args.livenessState && args.livenessState !== "normal") return;

  const responseText = extractResponseText(args.resultJson);
  if (!responseText.trim()) return;

  const needsReview = REVIEW_MARKER.test(responseText);
  const target: TaskStatus = needsReview ? "review" : "done";

  // Append a result block. Drop empty trailing paragraph so fresh tasks (which
  // start with a single blank paragraph) don't render an awkward gap.
  const row = await loadTaskStatusAndBlocks(args.taskId);
  if (!row) return;

  const agentName = await loadAgentName(args.agentId);
  const resultBlock: ContentBlock = {
    type: "agent_result",
    traceId: args.traceId,
    agentId: args.agentId,
    agentName,
    timestamp: args.finishedAt.toISOString(),
    preview: buildPreview(responseText),
  };

  const trimmed =
    row.blocks.length > 0 &&
    row.blocks[row.blocks.length - 1].type === "paragraph" &&
    !(row.blocks[row.blocks.length - 1] as { text: string }).text.trim()
      ? row.blocks.slice(0, -1)
      : row.blocks;
  await appendBlocks(args.taskId, [...trimmed, resultBlock]);

  // Only advance from active states — never resurrect a user-cancelled or
  // already-closed task.
  await setTaskStatus(args.taskId, ["todo", "in_progress"], target);
}
