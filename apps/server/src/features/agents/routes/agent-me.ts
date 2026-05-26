// GET /api/me/agent — agent-token authenticated: return the deployment's
// own DTO. Used by the agent runtime to introspect its own identity on
// wake.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { eq } from "drizzle-orm";
import { deployments } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { requireAgentToken } from "../../../middleware/agent-auth";
import { hydrateDeploymentDTO } from "../services/deployment-status";

const router: Router = Router();

router.get("/", requireAgentToken, async (req: Request, res: Response) => {
  const deploymentId = req.agent!.agentId;
  const [row] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!row) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.AGENT_NOT_FOUND });
    return;
  }
  res.json({ agent: await hydrateDeploymentDTO(row) });
});

export default router;
