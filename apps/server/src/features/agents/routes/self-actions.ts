// Agent-self approval submit. Auth is the AGENT bearer token, NOT the
// user JWT — so a running agent can ask for user approval before
// performing an action that requires consent.
//
// Today supported actions:
//   - delegate — agent X requests to delegate a sub-task to agent Y
//                (requires Y to be inside X's hire subtree)
//   - hire     — any agent in the company may request a new hire
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
import { canHire } from "../services/agent-hierarchy";

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

    // Both delegate and hire snapshot the requester's running task as
    // parentTaskId if the caller omitted one, so the eventual child task
    // is always linked into the graph.
    const resolveParentTaskId = async (
      explicit: string | null | undefined,
    ): Promise<string | null> => {
      if (explicit !== undefined && explicit !== null) return explicit;
      const [latest] = await db
        .select({ taskId: traces.taskId })
        .from(traces)
        .where(and(eq(traces.agentId, agentId), eq(traces.status, "running")))
        .orderBy(desc(traces.createdAt))
        .limit(1);
      return latest?.taskId ?? null;
    };

    if (actionType === "delegate") {
      const dp = payload as DelegatePayload;

      // Subtree validation — block self-hires, cross-company, out-of-scope.
      const check = await canHire(agentId, dp.targetAgentId);
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
          requestedByAgentId: agentId,
          actionType: "delegate",
          payload: { ...dp, parentTaskId },
        })
        .returning({ id: approvals.id });

      const body: AgentApprovalCreateResponse = { approvalId: row.id };
      res.status(StatusCodes.CREATED).json(body);
      return;
    }

    if (actionType === "hire") {
      // Hire authority: any agent in the company may request a hire.
      // The new agent's parentAgentId becomes the requester so the org
      // tree builds organically. Role validation already happened at
      // the Zod layer (AGENT_ROLES enum).
      const hp = payload;
      const parentTaskId = await resolveParentTaskId(hp.parentTaskId);

      const [row] = await db
        .insert(approvals)
        .values({
          companyId,
          requestedByAgentId: agentId,
          actionType: "hire",
          payload: { ...hp, parentTaskId },
        })
        .returning({ id: approvals.id });

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
