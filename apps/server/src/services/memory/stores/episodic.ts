// Episodic store — the company's memory of what it has done: recently
// completed tasks and prior documents. A memory TYPE (episodic / "what
// happened"); the assembler loads it on-demand, branched by surface.
//
// Retrieval today is recency- and tag-based. This is the store where
// proper relevance retrieval and the salience/decay scoring lands when
// the company has a long enough history to need it.

import {
  listByAnyTag as listDocumentsByAnyTag,
  listRecentDeliverables,
  deliverableTagDistribution,
} from "../../../features/documents/repositories/documents";
import { listRecentDoneTasksByCompany } from "../../../features/tasks/repositories/tasks";
import type { ContextHistory, SurfacePayload } from "../spec";

// Tight by default — history is supplementary signal, not the main
// payload. Renderers decide whether to embed full content or just the
// snippet. Adjust if quality testing shows we need more / less recall.
const HISTORY_RECENT_TASKS_LIMIT = 5;
const HISTORY_RELEVANT_DOCS_LIMIT = 5;
const HISTORY_DOC_SNIPPET_LEN = 240;

// Coverage signal bounds. Recent deliverables are COUNT-bounded so a burst
// day (one news cycle can spawn 200+ docs) can't flood the prompt; the tag
// window is TIME-bounded for long memory, cheap because it returns counts only.
// 80 covers a full day even at an aggressive cadence (≈48 cycles/day), so a
// new cycle always sees everything already shipped today — the dedup signal
// never drops a same-day story off the bottom of the list.
const COVERAGE_RECENT_LIMIT = 80;
const COVERAGE_TAG_WINDOW_DAYS = 90;
const COVERAGE_TAG_LIMIT = 20;

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

  // task surface — three optional signals, loaded together:
  //   • relevantDocuments — tag-matched prior work, genuine topical reference
  //   • recentlyProduced  — recent shipped deliverables, the dedup signal
  //   • tagDistribution   — coverage by area, the gap signal
  // The old recency-fallback for relevantDocuments is intentionally gone: when
  // a task has no tag match, recentlyProduced (deliverables only) is the
  // cleaner "what we shipped lately" signal than a mixed recent-docs list that
  // dragged in process scratch.
  const [tagged, recent, distribution] = await Promise.all([
    args.surface.tags.length > 0
      ? listDocumentsByAnyTag({
          companyId: args.companyId,
          tags: args.surface.tags,
          limit: HISTORY_RELEVANT_DOCS_LIMIT,
        })
      : [],
    listRecentDeliverables({
      companyId: args.companyId,
      limit: COVERAGE_RECENT_LIMIT,
    }),
    deliverableTagDistribution({
      companyId: args.companyId,
      sinceDays: COVERAGE_TAG_WINDOW_DAYS,
      limit: COVERAGE_TAG_LIMIT,
    }),
  ]);

  const relevantDocuments =
    tagged.length > 0
      ? tagged.map((d) => ({
          id: d.id,
          title: d.title,
          snippet: d.content.slice(0, HISTORY_DOC_SNIPPET_LEN),
        }))
      : undefined;
  const recentlyProduced =
    recent.length > 0
      ? recent.map((d) => ({
          title: d.title,
          tags: d.tags,
          producedAt: d.createdAt.toISOString().slice(0, 10),
        }))
      : undefined;
  const tagDistribution = distribution.length > 0 ? distribution : undefined;

  if (!relevantDocuments && !recentlyProduced && !tagDistribution) {
    return undefined;
  }
  return { relevantDocuments, recentlyProduced, tagDistribution };
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
