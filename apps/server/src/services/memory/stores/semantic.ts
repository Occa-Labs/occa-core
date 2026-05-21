// Semantic store — the company's distilled knowledge: facts and reference
// material the agent can draw on, held as Company Brain files. A memory
// TYPE (semantic / "knowledge that"); the assembler loads it on-demand.
// Today retrieval is "all visible rows"; this is the seam where relevance
// retrieval (RAG) lands when the knowledge base outgrows full inclusion.

import { and, eq, inArray } from "drizzle-orm";
import { companyBrain } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import type {
  ContextAgent,
  ContextBrainFile,
  ContextKnowledge,
} from "../spec";

// What visibility tiers should this agent see? CEO = everything; Heads =
// `all` + `tier:head`; specialists = `all` only. Returning [] would mean
// "no rows" — every agent today sees at least `all`, so we never return [].
function visibilityScopesForTier(tier: ContextAgent["tier"]): string[] {
  if (tier === "ceo") return ["all", "ceo_only", "tier:head"];
  if (tier === "head") return ["all", "tier:head"];
  return ["all"];
}

// Loads the Company Brain, visibility-filtered to what the calling agent
// is allowed to see. Filtering happens at query time so the renderer
// never receives blocks the agent shouldn't have. Returns undefined when
// the company has no brain rows yet — renderers `?? null`-handle that.
export async function loadKnowledge(args: {
  companyId: string;
  agentTier: ContextAgent["tier"];
}): Promise<ContextKnowledge | undefined> {
  const allowedVisibilities = visibilityScopesForTier(args.agentTier);
  const brainRows =
    allowedVisibilities.length > 0
      ? await db
          .select({
            path: companyBrain.path,
            content: companyBrain.content,
          })
          .from(companyBrain)
          .where(
            and(
              eq(companyBrain.companyId, args.companyId),
              inArray(companyBrain.visibility, allowedVisibilities),
            ),
          )
          .orderBy(companyBrain.path)
      : [];

  if (brainRows.length === 0) return undefined;

  return {
    brain: brainRows.map(
      (r): ContextBrainFile => ({
        path: r.path,
        content: r.content,
        sizeBytes: Buffer.byteLength(r.content, "utf8"),
      }),
    ),
  };
}
