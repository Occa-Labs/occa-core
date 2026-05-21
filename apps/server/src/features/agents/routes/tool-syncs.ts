// Per-agent tool toggle — operator picks which company-installed tools
// each deployment can discover via /api/me/agent/tools. Tools live at
// company level (credentials, role gate); this surface just maintains
// the visibility whitelist on each runtime profile. No sync state
// machine like skills — flipping a tool is a single DB update.

import { Router, type Request, type Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { companyTools } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { requireAuth } from "../../../middleware/auth";
import { findOwnedByUserId } from "../repositories/deployments";
import {
  findByDeploymentId as findRuntimeProfile,
  setEnabledTools,
} from "../repositories/agent-runtime-profile";
import { hydrateDeploymentDTO } from "../services/deployment-status";

const router: Router = Router();

const syncToolsBody = z.object({
  enabledTools: z.array(z.string().uuid()).max(64),
});

// POST /api/agents/:id/tools/sync — replace the deployment's enabled_tools
// whitelist. Every passed UUID must reference a tool the company owns;
// stale IDs (tool deleted between client read and write) return 400 with
// the offending list. Empty array = no tools accessible.
router.post(
  "/:id/tools/sync",
  requireAuth,
  async (req: Request, res: Response) => {
    const existing = await findOwnedByUserId({
      userId: req.user!.userId,
      deploymentId: req.params.id,
    });
    if (!existing) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const profile = await findRuntimeProfile(existing.id);
    if (!profile) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }

    const parsed = syncToolsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.INVALID_BODY,
        detail: parsed.error.flatten(),
      });
      return;
    }
    const dedup = Array.from(new Set(parsed.data.enabledTools));

    if (dedup.length > 0) {
      const known = await db
        .select({ id: companyTools.id })
        .from(companyTools)
        .where(
          and(
            eq(companyTools.companyId, existing.companyId),
            inArray(companyTools.id, dedup),
          ),
        );
      const knownSet = new Set(known.map((r) => r.id));
      const unknown = dedup.filter((id) => !knownSet.has(id));
      if (unknown.length > 0) {
        res.status(StatusCodes.BAD_REQUEST).json({
          error: ERROR_CODES.UNKNOWN_TOOL_IDS,
          ids: unknown,
        });
        return;
      }
    }

    await setEnabledTools({ deploymentId: existing.id, enabledTools: dedup });
    res.json({ agent: await hydrateDeploymentDTO(existing) });
  },
);

export default router;
