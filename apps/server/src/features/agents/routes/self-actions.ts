// Agent-self approval submit. Auth is the AGENT bearer token, NOT the
// user JWT — so a running agent can ask for user approval before
// performing an action that requires consent.
//
// Today supported actions:
//   - delegate — agent X requests to delegate a sub-task to agent Y
//                (requires Y to be inside X's subtree)
//
// The agent's own ID + company come from the token middleware; clients
// never pass them. We snapshot the agent's most-recent running trace's
// taskId into the payload as `parentTaskId` if the agent omitted one,
// so the eventual child task is always linked into the graph.

import { Router, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { approvals, traces } from "@occa/shared/schema";
import type {
  AgentApprovalCreateResponse,
  DelegatePayload,
} from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import { requireAgentToken } from "../../../middleware/agent-auth";
import { approvalCreateBody } from "../domain/schemas";
import { canDeploy } from "../services/deployment-hierarchy";
import { notifyApprovalCreated } from "../../approvals/services/post-create";

const router: Router = Router();

router.post(
  "/me/approvals",
  requireAgentToken,
  async (req: Request, res: Response) => {
    const { agentId, companyId } = req.agent!;
    const parsed = approvalCreateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.INVALID_BODY,
        detail: parsed.error.flatten(),
      });
      return;
    }
    const { actionType, payload } = parsed.data;

    // Delegate snapshots the requester's running task as parentTaskId if
    // the caller omitted one, so the eventual child task is always linked
    // into the graph.
    const resolveParentTaskId = async (
      explicit: string | null | undefined,
    ): Promise<string | null> => {
      if (explicit !== undefined && explicit !== null) return explicit;
      const [latest] = await db
        .select({ taskId: traces.taskId })
        .from(traces)
        .where(
          and(eq(traces.deploymentId, agentId), eq(traces.status, "running")),
        )
        .orderBy(desc(traces.createdAt))
        .limit(1);
      return latest?.taskId ?? null;
    };

    if (actionType === "delegate") {
      const dp = payload as DelegatePayload;

      // Subtree validation — block self-deploys, cross-company, out-of-scope.
      const check = await canDeploy(agentId, dp.targetAgentId);
      if (!check.ok) {
        res.status(StatusCodes.FORBIDDEN).json({
          error: ERROR_CODES.HIRE_NOT_ALLOWED,
          reason: check.reason,
        });
        return;
      }

      const parentTaskId = await resolveParentTaskId(dp.parentTaskId);

      const [row] = await db
        .insert(approvals)
        .values({
          companyId,
          requestedByDeploymentId: agentId,
          actionType: "delegate",
          payload: { ...dp, parentTaskId },
        })
        .returning();

      // Fire-and-forget — notification emit failure must not fail the
      // approval submission. notifyApprovalCreated swallows + logs.
      void notifyApprovalCreated(row);

      const body: AgentApprovalCreateResponse = { approvalId: row.id };
      res.status(StatusCodes.CREATED).json(body);
      return;
    }

    // Unreachable — Zod discriminator already narrowed to known kinds.
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.UNSUPPORTED_ACTION_TYPE });
  },
);

export default router;
