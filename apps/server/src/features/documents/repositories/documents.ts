// Documents repository (Tier 3b of the Context Pipeline). Auto-saved
// task deliverables, immutable. See `packages/shared/src/schema.ts`
// `documents` table for header rationale.

import { and, arrayOverlaps, desc, eq, inArray } from "drizzle-orm";
import { documents } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type DocumentRow = typeof documents.$inferSelect;
export type DocumentInsert = typeof documents.$inferInsert;

export async function insertDocument(
  input: DocumentInsert,
): Promise<DocumentRow> {
  const [row] = await db.insert(documents).values(input).returning();
  return row;
}

// Latest N documents for a company. Used by chat surface to surface
// "recent work" snapshot — agent gets a feel for what the team shipped
// without paying for full document bodies.
export async function listRecent(args: {
  companyId: string;
  limit: number;
}): Promise<DocumentRow[]> {
  return db
    .select()
    .from(documents)
    .where(eq(documents.companyId, args.companyId))
    .orderBy(desc(documents.createdAt))
    .limit(args.limit);
}

// Tag-matched documents — ANY overlap between doc.tags and `tags`. Used
// by task surface so a specialist starting a new piece can reference
// related prior work without dragging the entire archive into context.
// Empty `tags` short-circuits to no rows (intersect with empty = empty
// by convention).
export async function listByAnyTag(args: {
  companyId: string;
  tags: string[];
  limit: number;
}): Promise<DocumentRow[]> {
  if (args.tags.length === 0) return [];
  return db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.companyId, args.companyId),
        arrayOverlaps(documents.tags, args.tags),
      ),
    )
    .orderBy(desc(documents.createdAt))
    .limit(args.limit);
}

// Reverse lookup — given a set of task ids, fetch the documents that
// originated from them. Used when we want to attach docs back to their
// source tasks (e.g. cascade UI, debug tooling).
export async function listByTaskIds(
  taskIds: string[],
): Promise<DocumentRow[]> {
  if (taskIds.length === 0) return [];
  return db
    .select()
    .from(documents)
    .where(inArray(documents.taskId, taskIds));
}

export async function findById(args: {
  companyId: string;
  id: string;
}): Promise<DocumentRow | undefined> {
  const [row] = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.companyId, args.companyId),
        eq(documents.id, args.id),
      ),
    )
    .limit(1);
  return row;
}
