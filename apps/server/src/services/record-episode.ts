// Episodic-memory write-back bridge. After a news task settles `done`,
// records one episode — category, title, recap — so the company keeps a
// memory of its own coverage. That memory is what stops a Head picking
// the same topic two days running.
//
// Lives in `services/` (legacy spine) because it bridges `features/tasks`
// (the dispatcher) and `features/episodic-memory` — CLAUDE.md forbids
// feature-to-feature imports. Mirrors `auto-save-document.ts`.
// Best-effort: a failure never blocks the dispatch close-out.

import { childLogger } from "../lib/logger";
import { insertEpisode } from "../features/episodic-memory/repositories/episodic-memory";
import { deriveCategory } from "../features/episodic-memory/domain/category";

const log = childLogger("services:record-episode");

const SUMMARY_MAX = 220;

export interface RecordEpisodeInput {
  companyId: string;
  taskId: string;
  title: string;
  /** The clean, markers-stripped deliverable. */
  content: string;
  agent: { name: string; role: string };
  traceId: string;
  occurredAt: Date;
}

// First real paragraph of the deliverable, trimmed — a scannable recap.
function firstParagraph(markdown: string): string {
  const para = markdown
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !/^[#>|]/.test(p));
  const plain = (para ?? "").replace(/\s+/g, " ").trim();
  return plain.length > SUMMARY_MAX
    ? `${plain.slice(0, SUMMARY_MAX).trimEnd()}…`
    : plain;
}

export async function recordEpisode(
  input: RecordEpisodeInput,
): Promise<void> {
  try {
    const category = deriveCategory(`${input.title}\n${input.content}`);
    const summary = firstParagraph(input.content) || input.title;
    await insertEpisode({
      companyId: input.companyId,
      kind: "story_published",
      occurredAt: input.occurredAt,
      category,
      title: input.title,
      summary,
      payload: {
        taskId: input.taskId,
        agentName: input.agent.name,
        agentRole: input.agent.role,
        traceId: input.traceId,
      },
    });
    log.info({ taskId: input.taskId, category }, "episode recorded");
  } catch (err) {
    log.error(
      { err, taskId: input.taskId },
      "recordEpisode failed (non-fatal)",
    );
  }
}
