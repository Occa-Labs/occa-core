// Episodic memory repository — the only place Drizzle touches the
// `episodic_memory` table.

import { and, desc, eq, gte } from "drizzle-orm";
import { episodicMemory } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type EpisodeRow = typeof episodicMemory.$inferSelect;
export type EpisodeInsert = typeof episodicMemory.$inferInsert;

export async function insertEpisode(
  input: EpisodeInsert,
): Promise<EpisodeRow> {
  const [row] = await db.insert(episodicMemory).values(input).returning();
  return row;
}

// Episodes for a company that occurred on or after `since`, newest
// first. Used to show recent coverage when a Head picks the next slate.
export async function listEpisodesSince(args: {
  companyId: string;
  since: Date;
  limit: number;
}): Promise<EpisodeRow[]> {
  return db
    .select()
    .from(episodicMemory)
    .where(
      and(
        eq(episodicMemory.companyId, args.companyId),
        gte(episodicMemory.occurredAt, args.since),
      ),
    )
    .orderBy(desc(episodicMemory.occurredAt))
    .limit(args.limit);
}
