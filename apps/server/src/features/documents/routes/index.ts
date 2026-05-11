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
  findById,
  listByAnyTag,
  listRecent,
  type DocumentRow,
} from "../repositories/documents";

const router: Router = Router();

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const listQuery = z.object({
  // Comma-separated tags for ANY-overlap filtering. Empty / missing →
  // returns recency-ordered (no tag filter).
  tags: z.string().optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_LIST_LIMIT)
    .default(DEFAULT_LIST_LIMIT),
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

  const rows =
    tagList.length > 0
      ? await listByAnyTag({
          companyId,
          tags: tagList,
          limit: parsed.data.limit,
        })
      : await listRecent({ companyId, limit: parsed.data.limit });

  res.json({ documents: rows.map(toDTO) });
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
