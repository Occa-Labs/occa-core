// Typed-action HTTP back-channel — POST /api/agents/me/actions/emit.
// Counterpart to block markers (HIRE/DELEGATE/BLOCK/ASK) for actions
// that need real-time validation and idempotency: EmitFollowUp,
// RequestInfo. Auth via the standard agent bearer token; per-action
// payload schemas are discriminated by `type`.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { requireAgentToken } from "../../../middleware/agent-auth";
import { childLogger } from "../../../lib/logger";
import { agentActionRequest } from "../domain/agent-actions-schemas";
import {
  AgentActionError,
  emitFollowUp,
  requestInfo,
} from "../services/agent-actions";

const log = childLogger("routes:agent-actions");
const router: Router = Router();

const REASON_TO_ERROR_CODE = {
  task_not_in_company: ERROR_CODES.TASK_NOT_IN_COMPANY,
  task_depth_exceeded: ERROR_CODES.TASK_DEPTH_EXCEEDED,
  task_children_exceeded: ERROR_CODES.TASK_CHILDREN_EXCEEDED,
} as const;

router.post(
  "/me/actions/emit",
  requireAgentToken,
  async (req: Request, res: Response) => {
    const parsed = agentActionRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.INVALID_BODY,
        detail: parsed.error.flatten(),
      });
      return;
    }

    const action = parsed.data;
    const agent = req.agent!;

    try {
      if (action.type === "EmitFollowUp") {
        const result = await emitFollowUp(agent, action);
        res
          .status(
            result.alreadyExisted ? StatusCodes.OK : StatusCodes.CREATED,
          )
          .json({
            taskId: result.taskId,
            alreadyExisted: result.alreadyExisted,
          });
        return;
      }

      if (action.type === "RequestInfo") {
        const result = await requestInfo(agent, action);
        res
          .status(
            result.alreadyExisted ? StatusCodes.OK : StatusCodes.CREATED,
          )
          .json({
            commentId: result.commentId,
            alreadyExisted: result.alreadyExisted,
          });
        return;
      }

      // Discriminated union exhausted — TypeScript guarantees unreachable.
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.UNSUPPORTED_ACTION_TYPE });
    } catch (err) {
      if (err instanceof AgentActionError) {
        const code = REASON_TO_ERROR_CODE[err.reason];
        const status =
          err.reason === "task_not_in_company"
            ? StatusCodes.FORBIDDEN
            : StatusCodes.UNPROCESSABLE_ENTITY;
        res.status(status).json({ error: code });
        return;
      }
      log.error(
        { err, agentId: agent.agentId, type: action.type },
        "agent action handler failed",
      );
      res
        .status(StatusCodes.INTERNAL_SERVER_ERROR)
        .json({ error: ERROR_CODES.INTERNAL_ERROR });
    }
  },
);

export default router;
