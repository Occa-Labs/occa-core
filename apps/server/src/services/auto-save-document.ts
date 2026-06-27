// Persist completed work as `documents` rows (Tier 3b of the Context
// Pipeline). Two entry points, both best-effort (failures log, never block
// the caller):
//
//   • saveDeliverableDocument — called by the publish tool when a finished
//     piece ships. Carries the REAL identity (headline title + topic tags
//     the agent supplied), so the documents store holds something memory can
//     dedup/coverage against. Always `kind: deliverable`.
//
//   • autoSaveTaskAsDocument — called by the dispatcher/finalize after any
//     task reaches `done`. The fallback capture for work that DIDN'T go
//     through publish. It (a) skips tasks that already published (the publish
//     tool wrote the canonical deliverable — no generic duplicate), (b) names
//     the doc from its content, not the originating-task title (so pipeline
//     stages read as their subject, not "News cycle"), and (c) classifies a
//     pipeline sub-task (`parent_task_id` set) as `process`, a standalone task
//     as `deliverable`.
//
// Lives in `services/` (legacy spine) rather than under either feature
// because it bridges `features/tasks` / `features/tools` (callers) and
// `features/documents` (writes the row) — CLAUDE.md forbids feature-to-feature
// imports, so the bridge lives outside both.

import { eq } from "drizzle-orm";
import { tasks } from "@occa/shared/schema";
import type { DocumentKind } from "@occa/shared/types";
import { db } from "../infra/database/client";
import { childLogger } from "../lib/logger";
import { deriveTitleFromContent } from "../lib/markdown-title";
import { insertDocument } from "../features/documents/repositories/documents";

const log = childLogger("services:auto-save-document");

// A shipped deliverable from the publish tool — explicit title + tags, never
// derived. This is the row the coverage signal is built to read.
export interface SaveDeliverableInput {
  companyId: string;
  taskId: string | null; // the running task, if any
  deploymentId: string | null; // who produced it
  title: string;
  content: string; // markdown body
  format?: string;
  tags: string[];
  url?: string | null; // live URL the receiver returned, when published
}

export async function saveDeliverableDocument(
  input: SaveDeliverableInput,
): Promise<void> {
  if (input.content.trim().length === 0) return;
  try {
    const doc = await insertDocument({
      companyId: input.companyId,
      taskId: input.taskId,
      deploymentId: input.deploymentId,
      title: input.title,
      content: input.content,
      format: input.format ?? "markdown",
      url: input.url ?? null,
      tags: input.tags,
      kind: "deliverable" satisfies DocumentKind,
    });
    log.info(
      { documentId: doc.id, taskId: input.taskId, tagCount: doc.tags.length },
      "deliverable saved as document",
    );
  } catch (err) {
    log.error(
      { err, taskId: input.taskId },
      "save deliverable document failed (non-fatal)",
    );
  }
}

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
      parentTaskId: tasks.parentTaskId,
      resultUri: tasks.resultUri,
    })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1);

  if (!taskRow) {
    log.warn({ taskId: input.taskId }, "task not found for auto-save");
    return;
  }

  // Already published → the publish tool wrote the canonical deliverable with
  // its real headline + tags. Skip so we don't shadow it with a generic
  // task-titled duplicate (this is what kept producing "News cycle" rows).
  if (taskRow.resultUri && taskRow.resultUri.trim().length > 0) {
    return;
  }

  // Name the doc from its own content; fall back to the task title only when
  // the content has no heading or first line to lift.
  const title = deriveTitleFromContent(input.cleanReply, taskRow.title);
  // A pipeline sub-task is process scratch; a standalone task's reply is the
  // deliverable.
  const kind: DocumentKind = taskRow.parentTaskId ? "process" : "deliverable";

  try {
    const doc = await insertDocument({
      companyId: taskRow.companyId,
      taskId: input.taskId,
      deploymentId: input.deploymentId,
      title,
      content: input.cleanReply,
      format: "markdown",
      tags: taskRow.tags ?? [],
      kind,
    });
    log.info(
      {
        documentId: doc.id,
        taskId: input.taskId,
        kind,
        tagCount: doc.tags.length,
      },
      "task auto-saved as document",
    );
  } catch (err) {
    log.error(
      { err, taskId: input.taskId },
      "auto-save document failed (non-fatal)",
    );
  }
}
