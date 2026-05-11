// Auto-save a completed task as a `documents` row (Tier 3b of the
// Context Pipeline). Called once from the dispatcher after a task
// transitions to `done` with a non-empty agent_result. Best-effort:
// failures are logged but never block the dispatch close-out.
//
// Lives in `services/` (legacy spine) rather than under either feature
// because it bridges `features/tasks` (reads task row) and
// `features/documents` (writes document row) — CLAUDE.md forbids
// feature-to-feature imports, so the bridge lives outside both.
//
// Snapshot content is the clean agent reply (already markers-stripped
// by the dispatcher). Title + tags + originating ids come from the task
// row. Immutable — repeat runs of the same task generate new rows.

import { eq } from "drizzle-orm";
import { tasks } from "@occa/shared/schema";
import { db } from "../infra/database/client";
import { childLogger } from "../lib/logger";
import { insertDocument } from "../features/documents/repositories/documents";

const log = childLogger("services:auto-save-document");

export interface AutoSaveDocumentInput {
  taskId: string;
  deploymentId: string; // who produced the result
  cleanReply: string; // already stripped of OCCA markers
}

export async function autoSaveTaskAsDocument(
  input: AutoSaveDocumentInput,
): Promise<void> {
  if (input.cleanReply.trim().length === 0) {
    // Nothing to snapshot. Common when an agent emits only a marker
    // (e.g. pure DELEGATE) — that isn't a deliverable.
    return;
  }

  const [taskRow] = await db
    .select({
      companyId: tasks.companyId,
      title: tasks.title,
      tags: tasks.tags,
    })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1);

  if (!taskRow) {
    log.warn({ taskId: input.taskId }, "task not found for auto-save");
    return;
  }

  try {
    const doc = await insertDocument({
      companyId: taskRow.companyId,
      taskId: input.taskId,
      deploymentId: input.deploymentId,
      title: taskRow.title,
      content: input.cleanReply,
      format: "markdown",
      tags: taskRow.tags ?? [],
    });
    log.info(
      { documentId: doc.id, taskId: input.taskId, tagCount: doc.tags.length },
      "task auto-saved as document",
    );
  } catch (err) {
    log.error(
      { err, taskId: input.taskId },
      "auto-save document failed (non-fatal)",
    );
  }
}
