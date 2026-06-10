// Read-only per-task usage summary. User-JWT authenticated. Mounted under
// /api/tasks, so the path resolves to /api/tasks/:id/usage. Sums the
// token/cost across every trace the task ran (re-dispatches accumulate).

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import type { TaskUsageSummary } from "@occa/shared/types";
import { requireAuth } from "../../../middleware/auth";
import { findTaskInCompany, sumTaskUsage } from "../repositories/tasks";
import { userCompanyId } from "./helpers";

const router: Router = Router();

router.get("/:id/usage", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
    return;
  }
  const task = await findTaskInCompany(req.params.id, companyId);
  if (!task) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TASK_NOT_FOUND });
    return;
  }
  const summary: TaskUsageSummary = await sumTaskUsage(req.params.id);
  res.json(summary);
});

export default router;
