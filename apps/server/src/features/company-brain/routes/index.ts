// Company Brain CRUD — owner-facing surface for the Tier 3a knowledge
// store. Scoped to the authenticated user's company; cross-company reads
// are blocked at every route by `userCompanyId()`.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../../infra/database/client";
import { companies } from "@occa/shared/schema";
import { PG_ERROR_CODES } from "../../../lib/pg-errors";
import { requireAuth } from "../../../middleware/auth";
import {
  createBrainFileBody,
  updateBrainFileBody,
} from "../domain/schemas";
import {
  deleteBrainFileById,
  findById,
  insertBrainFile,
  listForCompany,
  updateBrainFileById,
  type CompanyBrainRow,
} from "../repositories/company-brain";

const router: Router = Router();

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

interface BrainFileDTO {
  id: string;
  path: string;
  content: string;
  visibility: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

function toDTO(row: CompanyBrainRow): BrainFileDTO {
  return {
    id: row.id,
    path: row.path,
    content: row.content,
    visibility: row.visibility,
    sizeBytes: Buffer.byteLength(row.content, "utf8"),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId)
    return res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.NOT_FOUND });

  const rows = await listForCompany(companyId);
  res.json({ files: rows.map(toDTO) });
});

router.post("/", requireAuth, async (req: Request, res: Response) => {
  const parsed = createBrainFileBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_BODY,
      details: parsed.error.flatten(),
    });
  }
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId)
    return res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.NOT_FOUND });

  try {
    const row = await insertBrainFile({
      companyId,
      path: parsed.data.path,
      content: parsed.data.content,
      visibility: parsed.data.visibility,
      updatedBy: req.user!.userId,
    });
    res.status(StatusCodes.CREATED).json({ file: toDTO(row) });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === PG_ERROR_CODES.UNIQUE_VIOLATION
    ) {
      return res.status(StatusCodes.CONFLICT).json({
        error: ERROR_CODES.BRAIN_PATH_CONFLICT,
        message: "A brain file at this path already exists",
      });
    }
    req.log.error({ err }, "create brain file failed");
    res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json({ error: ERROR_CODES.INTERNAL_ERROR });
  }
});

router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const parsed = updateBrainFileBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_BODY,
      details: parsed.error.flatten(),
    });
  }
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId)
    return res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.NOT_FOUND });

  const existing = await findById({ companyId, id: req.params.id });
  if (!existing)
    return res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.NOT_FOUND });

  const row = await updateBrainFileById({
    companyId,
    id: req.params.id,
    updates: {
      content: parsed.data.content,
      visibility: parsed.data.visibility,
      updatedBy: req.user!.userId,
    },
  });
  if (!row)
    return res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.NOT_FOUND });

  res.json({ file: toDTO(row) });
});

router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId)
    return res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.NOT_FOUND });

  const deleted = await deleteBrainFileById({ companyId, id: req.params.id });
  if (!deleted)
    return res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.NOT_FOUND });

  res.status(StatusCodes.NO_CONTENT).end();
});

export default router;
