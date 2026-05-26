// GET /api/me/agent/tools — list active tools the calling agent is
// allowed to use. Filter chain (mirrors skills semantics):
//   1. tool.status == 'active' (operator gate; paused/failed hidden)
//   2. tool.id is in the agent's enabled_tools (per-agent toggle)
//   3. tool.allowed_roles empty OR includes the agent's deployment role
// Re-fetched on each wake so flag changes propagate without redeploy.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { eq } from "drizzle-orm";
import {
  agentRuntimeProfile,
  companyTools,
  deployments,
} from "@occa/shared/schema";
import type {
  AgentToolDTO,
  ListAgentToolsResponse,
} from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import { requireAgentToken } from "../../../middleware/agent-auth";
import { listCatalog } from "../services/catalog-loader";

const router: Router = Router();

router.get("/", requireAgentToken, async (req: Request, res: Response) => {
  const { companyId, agentId: deploymentId } = req.agent!;

  const [deploymentRow] = await db
    .select({
      role: deployments.role,
      enabledTools: agentRuntimeProfile.enabledTools,
    })
    .from(deployments)
    .innerJoin(
      agentRuntimeProfile,
      eq(agentRuntimeProfile.deploymentId, deployments.id),
    )
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!deploymentRow) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  const enabledSet = new Set(deploymentRow.enabledTools);

  const rows = await db
    .select({
      id: companyTools.id,
      type: companyTools.type,
      label: companyTools.label,
      status: companyTools.status,
      allowedRoles: companyTools.allowedRoles,
    })
    .from(companyTools)
    .where(eq(companyTools.companyId, companyId));

  const catalog = await listCatalog();
  const catalogByType = new Map(catalog.map((e) => [e.type, e]));

  const tools: AgentToolDTO[] = rows
    .filter((r) => r.status === "active")
    .filter((r) => enabledSet.has(r.id))
    .filter((r) => {
      const allowed = r.allowedRoles ?? [];
      return allowed.length === 0 || allowed.includes(deploymentRow.role);
    })
    .map((r) => {
      const entry = catalogByType.get(r.type);
      return {
        id: r.id,
        type: r.type,
        label: r.label,
        displayName: entry?.displayName ?? r.type,
        status: r.status as AgentToolDTO["status"],
        // Static actions only for v1. MCP-backed tools with dynamic
        // actions would need a live tools/list call; deferring that
        // optimization until a real MCP entry lands.
        actions: entry?.actions ?? [],
      };
    });

  const body: ListAgentToolsResponse = { tools };
  res.json(body);
});

export default router;
