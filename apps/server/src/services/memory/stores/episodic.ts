// Episodic store — the company's memory of what it has done: recently
// completed tasks and prior documents. A memory TYPE (episodic / "what
// happened"); the assembler loads it on-demand, branched by surface.
//
// Retrieval today is recency- and tag-based. This is the store where
// proper relevance retrieval and the salience/decay scoring lands when
// the company has a long enough history to need it.

import {
  listByAnyTag as listDocumentsByAnyTag,
  listRecent as listRecentDocuments,
} from "../../../features/documents/repositories/documents";
import { listRecentDoneTasksByCompany } from "../../../features/tasks/repositories/tasks";
import type { ContextHistory, SurfacePayload } from "../spec";

// Tight by default — history is supplementary signal, not the main
// payload. Renderers decide whether to embed full content or just the
// snippet. Adjust if quality testing shows we need more / less recall.
const HISTORY_RECENT_TASKS_LIMIT = 5;
const HISTORY_RELEVANT_DOCS_LIMIT = 5;
const HISTORY_DOC_SNIPPET_LEN = 240;

// Loads the episodic slice most useful to the calling surface:
//   • chat / agent_dm → "what did the team ship recently?"
//   • task            → "any prior work matching my tags?", falling back
//                        to recent documents when the task has no tags or
//                        no tag-matched docs exist.
export async function loadHistory(args: {
  companyId: string;
  surface: SurfacePayload;
}): Promise<ContextHistory | undefined> {
  if (args.surface.kind === "chat" || args.surface.kind === "agent_dm") {
    const recent = await listRecentDoneTasksByCompany({
      companyId: args.companyId,
      limit: HISTORY_RECENT_TASKS_LIMIT,
    });
    if (recent.length === 0) return undefined;
    return {
      recentCompletedTasks: recent.map((t) => ({
        taskNumber: t.taskNumber,
        title: t.title,
        summary: extractResultPreview(t.blocks) ?? "(no result preview)",
      })),
    };
  }

  // task surface — tag-matched docs first, fallback to recent if empty.
  const tagged =
    args.surface.tags.length > 0
      ? await listDocumentsByAnyTag({
          companyId: args.companyId,
          tags: args.surface.tags,
          limit: HISTORY_RELEVANT_DOCS_LIMIT,
        })
      : [];

  const docs =
    tagged.length > 0
      ? tagged
      : await listRecentDocuments({
          companyId: args.companyId,
          limit: HISTORY_RELEVANT_DOCS_LIMIT,
        });

  if (docs.length === 0) return undefined;
  return {
    relevantDocuments: docs.map((d) => ({
      id: d.id,
      title: d.title,
      snippet: d.content.slice(0, HISTORY_DOC_SNIPPET_LEN),
    })),
  };
}

// Pull the agent_result preview out of a task's blocks JSON. Matches the
// shape persisted by the dispatcher in closeSucceededTrace. Returns null
// when no agent_result block exists (task done by human action, etc.).
function extractResultPreview(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (
      b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "agent_result"
    ) {
      const preview = (b as { preview?: unknown }).preview;
      if (typeof preview === "string") return preview;
    }
  }
  return null;
}
