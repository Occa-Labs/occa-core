// Agent-token authenticated comment routes. Mounted under /api/agents
// (so paths resolve to /api/agents/me/:id/comments). Same backing
// service as the user-JWT routes — only the auth surface differs.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import type {
  ListTaskCommentsResponse,
  TaskCommentResponse,
} from "@occa/shared/types";
import { childLogger } from "../../../lib/logger";
import { requireAgentToken } from "../../../middleware/agent-auth";
import { commentBody } from "../domain/schemas";
import { findTaskInCompany } from "../repositories/tasks";
import { createTaskComment, listTaskComments } from "../services/comments";

const log = childLogger("routes:tasks:agent-comments");
const router: Router = Router();

router.get(
  "/me/:id/comments",
  requireAgentToken,
  async (req: Request, res: Response) => {
    const { companyId } = req.agent!;
    const task = await findTaskInCompany(req.params.id, companyId);
    if (!task) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.TASK_NOT_FOUND });
      return;
    }
    const comments = await listTaskComments(req.params.id, companyId);
    const body: ListTaskCommentsResponse = { comments };
    res.json(body);
  },
);

router.post(
  "/me/:id/comments",
  requireAgentToken,
  async (req: Request, res: Response) => {
    const { agentId, companyId } = req.agent!;
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
        authorAgentId: agentId,
        body: parsed.data.body,
      });
      const body: TaskCommentResponse = { comment: result.comment };
      res.status(StatusCodes.CREATED).json(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "comment_failed";
      if (msg.startsWith("comment_task_not_in_company")) {
        res
          .status(StatusCodes.NOT_FOUND)
          .json({ error: ERROR_CODES.TASK_NOT_FOUND });
        return;
      }
      log.error({ err }, "agent comment insert failed");
      res
        .status(StatusCodes.INTERNAL_SERVER_ERROR)
        .json({ error: ERROR_CODES.COMMENT_FAILED });
    }
  },
);

export default router;
