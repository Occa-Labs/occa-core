// Task comment routes — user JWT authenticated. Mounted under
// /api/tasks (so the path resolves to /api/tasks/:id/comments).

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import type {
  ListTaskCommentsResponse,
  TaskCommentResponse,
} from "@occa/shared/types";
import { childLogger } from "../../../lib/logger";
import { requireAuth } from "../../../middleware/auth";
import { commentBody } from "../domain/schemas";
import { findTaskInCompany } from "../repositories/tasks";
import { createTaskComment, listTaskComments } from "../services/comments";
import { userCompanyId } from "./helpers";

const log = childLogger("routes:tasks:comments");
const router: Router = Router();

router.get("/:id/comments", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
    return;
  }
  const task = await findTaskInCompany(req.params.id, companyId);
  if (!task) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TASK_NOT_FOUND });
    return;
  }
  const comments = await listTaskComments(req.params.id, companyId);
  const body: ListTaskCommentsResponse = { comments };
  res.json(body);
});

router.post("/:id/comments", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
    return;
  }
  const parsed = commentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_BODY,
      detail: parsed.error.flatten(),
    });
    return;
  }
  try {
    const result = await createTaskComment({
      taskId: req.params.id,
      companyId,
      authorUserId: req.user!.userId,
      body: parsed.data.body,
    });
    const body: TaskCommentResponse = { comment: result.comment };
    res.status(StatusCodes.CREATED).json(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "comment_failed";
    if (msg.startsWith("comment_task_not_in_company")) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TASK_NOT_FOUND });
      return;
    }
    log.error({ err }, "user comment insert failed");
    res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json({ error: ERROR_CODES.COMMENT_FAILED });
  }
});

export default router;
