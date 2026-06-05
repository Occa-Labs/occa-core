// Documents read API — owner-facing browser for auto-saved task
// deliverables. Read-only: documents are immutable once persisted, and
// edits would invalidate the "history snapshot" semantics that the
// Context Pipeline depends on. Scoped to the authenticated user's
// company at every route.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../infra/database/client";
import { companies } from "@occa/shared/schema";
import { requireAuth } from "../../../middleware/auth";
import {
  countDocuments,
  countUntaggedDocuments,
  documentDateFolders,
  documentTagFolders,
  findById,
  listDocuments,
  type DocumentRow,
} from "../repositories/documents";

const router: Router = Router();

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const MAX_TZ_LEN = 64;
const MAX_SEARCH_LEN = 200;

const listQuery = z.object({
  // Comma-separated tags for ANY-overlap filtering. Empty / missing →
  // returns recency-ordered (no tag filter).
  tags: z.string().optional(),
  // `untagged=1` returns only documents with no tags (the Untagged folder).
  untagged: z.string().optional(),
  // Local calendar date (YYYY-MM-DD) to open a date folder, resolved in `tz`.
  day: z.string().max(10).optional(),
  tz: z.string().max(MAX_TZ_LEN).optional(),
  // Free-text search over title + content.
  search: z.string().max(MAX_SEARCH_LEN).optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_LIST_LIMIT)
    .default(DEFAULT_LIST_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

const foldersQuery = z.object({
  axis: z.enum(["date", "tags"]).default("date"),
  tz: z.string().max(MAX_TZ_LEN).default("UTC"),
});

async function userCompanyId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(
        eq(companies.ownerUserId, userId),
        eq(companies.kind, "user"),
        isNull(companies.deletedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

interface DocumentDTO {
  id: string;
  taskId: string | null;
  deploymentId: string | null;
  title: string;
  content: string;
  format: string;
  tags: string[];
  createdAt: string;
}

function toDTO(row: DocumentRow): DocumentDTO {
  return {
    id: row.id,
    taskId: row.taskId,
    deploymentId: row.deploymentId,
    title: row.title,
    content: row.content,
    format: row.format,
    tags: row.tags,
    createdAt: row.createdAt.toISOString(),
  };
}

router.get("/", requireAuth, async (req: Request, res: Response) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_QUERY,
      details: parsed.error.flatten(),
    });
  }
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId)
    return res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.NOT_FOUND });

  const tagList = parsed.data.tags
    ? parsed.data.tags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : [];

  // Fetch one extra row to detect a next page without a count query.
  const rows = await listDocuments({
    companyId,
    tags: tagList,
    untagged: parsed.data.untagged === "1",
    day: parsed.data.day,
    tz: parsed.data.tz,
    search: parsed.data.search,
    limit: parsed.data.limit + 1,
    offset: parsed.data.offset,
  });
  const hasMore = rows.length > parsed.data.limit;
  const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;

  res.json({ documents: page.map(toDTO), hasMore });
});

// Derived folder list for the sidebar + folder grid. Cheap aggregate — only
// {label, count} rows cross the wire, never document bodies.
router.get("/folders", requireAuth, async (req: Request, res: Response) => {
  const parsed = foldersQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_QUERY,
      details: parsed.error.flatten(),
    });
  }
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId)
    return res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.NOT_FOUND });

  const total = await countDocuments(companyId);

  if (parsed.data.axis === "tags") {
    const tags = await documentTagFolders({ companyId });
    const untagged = await countUntaggedDocuments(companyId);
    return res.json({
      folders: tags.map((t) => ({ id: t.tag, label: t.tag, count: t.count })),
      total,
      untagged,
    });
  }

  const days = await documentDateFolders({ companyId, tz: parsed.data.tz });
  return res.json({
    folders: days.map((d) => ({ id: d.day, label: d.day, count: d.count })),
    total,
    untagged: 0,
  });
});

router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId)
    return res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.NOT_FOUND });

  const row = await findById({ companyId, id: req.params.id });
  if (!row)
    return res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.NOT_FOUND });

  res.json({ document: toDTO(row) });
});

export default router;
