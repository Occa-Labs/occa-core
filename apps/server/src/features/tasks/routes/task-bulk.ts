// Bulk task actions for a board column. Mounted under /api/tasks, user-JWT
// authenticated. One endpoint covers both archive (soft-state) and delete
// (hard remove) so the board's per-column 3-dot menu has a single contract.
//
// `status` accepts any real TaskStatus or the pseudo-status "attention" (the
// board's combined blocked + error column) — mirroring the list route so the
// menu can act on exactly what the column shows.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { TASK_STATUSES, type TaskStatus } from "@occa/shared/types";
import { childLogger } from "../../../lib/logger";
import { requireAuth } from "../../../middleware/auth";
import {
  bulkArchiveByStatus,
  bulkDeleteByStatus,
} from "../repositories/tasks";
import { userCompanyId } from "./helpers";

const log = childLogger("routes:tasks:bulk");

// Combined blocked + error — the board's "Needs attention" column.
const ATTENTION_STATUSES: TaskStatus[] = ["blocked", "error"];

const router: Router = Router();

router.post("/bulk", requireAuth, async (req: Request, res: Response) => {
  const action =
    typeof req.body?.action === "string" ? req.body.action : undefined;
  const statusParam =
    typeof req.body?.status === "string" ? req.body.status : undefined;

  if (action !== "archive" && action !== "delete") {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_BODY,
      detail: "action must be 'archive' or 'delete'",
    });
    return;
  }

  const isAttention = statusParam === "attention";
  if (
    !statusParam ||
    (!isAttention && !TASK_STATUSES.includes(statusParam as TaskStatus))
  ) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_BODY,
      detail: "unknown status",
    });
    return;
  }

  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }

  const statuses = isAttention
    ? ATTENTION_STATUSES
    : [statusParam as TaskStatus];

  const affected =
    action === "archive"
      ? await bulkArchiveByStatus(companyId, statuses)
      : await bulkDeleteByStatus(companyId, statuses);

  res.json({ ok: true, affected });
  log.info({ action, statuses, affected }, "bulk task action");
});

export default router;
