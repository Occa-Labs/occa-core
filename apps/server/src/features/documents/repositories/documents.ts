// Documents repository (Tier 3b of the Context Pipeline). Auto-saved
// task deliverables, immutable. See `packages/shared/src/schema.ts`
// `documents` table for header rationale.

import { and, arrayOverlaps, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { documents } from "@occa/shared/schema";
import type { DocumentKind } from "@occa/shared/types";
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
// without paying for full document bodies. Optional `kind` filter keeps a
// recency-ordered list from being flooded by process scratch (each news
// cycle writes ~8 process docs per deliverable), which otherwise pushes the
// real deliverables out of a bounded window.
export async function listRecent(args: {
  companyId: string;
  limit: number;
  kind?: DocumentKind;
}): Promise<DocumentRow[]> {
  const conditions = [eq(documents.companyId, args.companyId)];
  if (args.kind) conditions.push(eq(documents.kind, args.kind));
  return db
    .select()
    .from(documents)
    .where(and(...conditions))
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
  kind?: DocumentKind;
}): Promise<DocumentRow[]> {
  if (args.tags.length === 0) return [];
  const conditions = [
    eq(documents.companyId, args.companyId),
    arrayOverlaps(documents.tags, args.tags),
  ];
  if (args.kind) conditions.push(eq(documents.kind, args.kind));
  return db
    .select()
    .from(documents)
    .where(and(...conditions))
    .orderBy(desc(documents.createdAt))
    .limit(args.limit);
}

// ── Coverage signal — fuels the memory pipeline's "avoid re-covering" block ──

// Recent SHIPPED deliverables — the coverage signal's high-resolution layer.
// Count-bounded (not time-bounded) so a burst day can't flood the prompt.
// kind='deliverable' excludes process scratch (draft / fact-check / SEO stage
// docs), so the agent sees what was actually published, not the pipeline.
export async function listRecentDeliverables(args: {
  companyId: string;
  limit: number;
}): Promise<{ title: string; tags: string[]; createdAt: Date }[]> {
  return db
    .select({
      title: documents.title,
      tags: documents.tags,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, args.companyId),
        eq(documents.kind, "deliverable"),
      ),
    )
    .orderBy(desc(documents.createdAt))
    .limit(args.limit);
}

// Per-tag deliverable counts within a recent window — the coverage signal's
// low-resolution, long-memory layer. Aggregate counts only, so it stays cheap
// across a long window. A document with N tags contributes to N tags.
export async function deliverableTagDistribution(args: {
  companyId: string;
  sinceDays: number;
  limit: number;
}): Promise<{ tag: string; count: number }[]> {
  const result = await db.execute<{ tag: string; count: number }>(sql`
    SELECT tag, count(*)::int AS count
    FROM documents, unnest(tags) AS tag
    WHERE company_id = ${args.companyId}::uuid
      AND kind = 'deliverable'
      AND created_at > now() - make_interval(days => ${args.sinceDays})
    GROUP BY tag
    ORDER BY count DESC, tag ASC
    LIMIT ${args.limit}
  `);
  return result.rows.map((r) => ({
    tag: String(r.tag),
    count: Number(r.count),
  }));
}

// ── Finder: paginated browse + derived folder aggregates ──────────────────
//
// The finder never pulls the full archive. Folder lists (dates / tags) come
// from cheap GROUP BY aggregates that return only labels + counts; document
// bodies are fetched one 50-row page at a time when a folder is opened.

// One page of documents, filtered by any of tag / day / free-text search.
// `day` is a local calendar date (YYYY-MM-DD) resolved in `tz` so the
// per-day grouping matches what the user sees in their own timezone.
export async function listDocuments(args: {
  companyId: string;
  tags?: string[];
  untagged?: boolean;
  day?: string;
  tz?: string;
  search?: string;
  limit: number;
  offset: number;
}): Promise<DocumentRow[]> {
  const conditions = [eq(documents.companyId, args.companyId)];

  if (args.untagged) {
    conditions.push(sql`cardinality(${documents.tags}) = 0`);
  } else if (args.tags && args.tags.length > 0) {
    conditions.push(arrayOverlaps(documents.tags, args.tags));
  }
  if (args.day) {
    const tz = args.tz ?? "UTC";
    conditions.push(
      sql`(${documents.createdAt} AT TIME ZONE ${tz})::date = ${args.day}::date`,
    );
  }
  const search = args.search?.trim();
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(ilike(documents.title, pattern), ilike(documents.content, pattern))!,
    );
  }

  return db
    .select()
    .from(documents)
    .where(and(...conditions))
    .orderBy(desc(documents.createdAt))
    .limit(args.limit)
    .offset(args.offset);
}

// Per-day counts in the user's timezone. Returns only {day, count} rows —
// no document bodies cross the wire, so this stays cheap at any archive size.
export async function documentDateFolders(args: {
  companyId: string;
  tz: string;
}): Promise<{ day: string; count: number }[]> {
  const result = await db.execute<{ day: string; count: number }>(sql`
    SELECT (created_at AT TIME ZONE ${args.tz})::date::text AS day,
           count(*)::int AS count
    FROM documents
    WHERE company_id = ${args.companyId}::uuid
    GROUP BY day
    ORDER BY day DESC
  `);
  return result.rows.map((r) => ({ day: String(r.day), count: Number(r.count) }));
}

// Per-tag counts. A document with N tags contributes to N folders.
export async function documentTagFolders(args: {
  companyId: string;
}): Promise<{ tag: string; count: number }[]> {
  const result = await db.execute<{ tag: string; count: number }>(sql`
    SELECT tag, count(*)::int AS count
    FROM documents, unnest(tags) AS tag
    WHERE company_id = ${args.companyId}::uuid
    GROUP BY tag
    ORDER BY count DESC, tag ASC
  `);
  return result.rows.map((r) => ({ tag: String(r.tag), count: Number(r.count) }));
}

export async function countDocuments(companyId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(eq(documents.companyId, companyId));
  return row?.count ?? 0;
}

export async function countUntaggedDocuments(companyId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, companyId),
        sql`cardinality(${documents.tags}) = 0`,
      ),
    );
  return row?.count ?? 0;
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
