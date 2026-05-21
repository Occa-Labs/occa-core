// POST /api/tools/:toolInstanceId/actions/:actionName
//
// Agent-facing invocation endpoint. The agent token resolves to a
// deployment + company; the tool must belong to that company. The
// service does the real work — this route is a thin HTTP shim.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { requireAgentToken } from "../../../middleware/agent-auth";
import { invokeToolBody } from "../domain/schemas";
import { invokeTool } from "../services/invoke";
import { LIMITS } from "../../../lib/limits";
import type {
  InvokeToolErrorResponse,
  InvokeToolResponse,
} from "@occa/shared/types";

const router: Router = Router();

router.post(
  "/:toolInstanceId/actions/:actionName",
  requireAgentToken,
  async (req: Request, res: Response) => {
    const agent = req.agent!;

    const parsed = invokeToolBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
      return;
    }

    // Cheap sanity ceiling on payload size before we touch crypto.
    if (JSON.stringify(parsed.data.input).length > LIMITS.TOOL_CALL_INPUT) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY, detail: "input too large" });
      return;
    }

    if (req.params.actionName.length > LIMITS.TOOL_ACTION_NAME) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.TOOL_ACTION_NOT_FOUND });
      return;
    }

    const outcome = await invokeTool({
      toolId: req.params.toolInstanceId,
      actionName: req.params.actionName,
      companyId: agent.companyId,
      deploymentId: agent.agentId,
      input: parsed.data.input,
    });

    switch (outcome.kind) {
      case "ok": {
        const body: InvokeToolResponse = { ok: true, output: outcome.output };
        res.json(body);
        return;
      }
      case "not_found": {
        const code =
          outcome.reason === "tool_not_found"
            ? ERROR_CODES.TOOL_NOT_FOUND
            : outcome.reason === "tool_type_unknown"
              ? ERROR_CODES.TOOL_TYPE_UNKNOWN
              : ERROR_CODES.TOOL_ACTION_NOT_FOUND;
        res.status(StatusCodes.NOT_FOUND).json({ error: code });
        return;
      }
      case "rejected": {
        if (outcome.reason === "tool_paused") {
          res
            .status(StatusCodes.CONFLICT)
            .json({ error: ERROR_CODES.TOOL_PAUSED });
          return;
        }
        if (outcome.reason === "invalid_credentials") {
          res
            .status(StatusCodes.FAILED_DEPENDENCY)
            .json({
              error: ERROR_CODES.INVALID_CREDENTIALS,
              detail: outcome.detail,
            });
          return;
        }
        // invalid_input
        res
          .status(StatusCodes.BAD_REQUEST)
          .json({ error: ERROR_CODES.INVALID_BODY, detail: outcome.detail });
        return;
      }
      case "failed": {
        const body: InvokeToolErrorResponse = {
          ok: false,
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage,
          rateLimited: outcome.rateLimited,
        };
        const status = outcome.rateLimited
          ? StatusCodes.TOO_MANY_REQUESTS
          : StatusCodes.BAD_GATEWAY;
        res.status(status).json(body);
        return;
      }
    }
  },
);

export default router;
