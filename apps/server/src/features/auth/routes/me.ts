// GET /api/me — authenticated user profile compositor.
//
// Returns user + active company + agents in one shot for the OS shell's
// boot fetch. Crosses feature boundaries (chain recovery, companies DTO,
// agents hydrate) by design — this is the OS-level "who am I" call,
// and forcing it into one feature would just split it elsewhere.
// Treat like services/ bridge code: legitimate cross-feature compositor.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { eq } from "drizzle-orm";
import { deployments, users } from "@occa/shared/schema";
import type { MeResponse } from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import { requireAuth } from "../../../middleware/auth";
import { hydrateDeploymentDTOs } from "../../agents/services/deployment-status";
import { toCompanyDTO } from "../../companies/domain/dto";
import { findActiveOwnerCompanyWithProfile } from "../../companies/repositories/companies";
import { recoverFromChainIfMissing } from "../../chain/services/chain-recovery";

const router: Router = Router();

router.get("/", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const [userRow] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!userRow) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: ERROR_CODES.USER_NOT_FOUND });
    return;
  }

  let loaded = await findActiveOwnerCompanyWithProfile(userId);

  // Chain-first recovery — DB cache may be empty (new device, DB wipe,
  // or onboarding via direct SDK). Per CLAUDE.md "Chain = truth, DB =
  // cache", look up the wallet's PDAs on-chain and rebuild the cache.
  // Only triggers when DB has nothing — happy path stays single-query.
  if (!loaded) {
    try {
      const result = await recoverFromChainIfMissing({
        userId,
        walletAddress: userRow.walletAddress,
      });
      if (result.recovered) {
        loaded = await findActiveOwnerCompanyWithProfile(userId);
      }
    } catch (err) {
      req.log.error({ err }, "chain recovery failed; serving empty /api/me");
    }
  }

  const deploymentRows = loaded
    ? await db
        .select()
        .from(deployments)
        .where(eq(deployments.companyId, loaded.company.id))
    : [];

  const response: MeResponse = {
    user: {
      id: userRow.id,
      walletAddress: userRow.walletAddress,
      isPlatform: userRow.isPlatform,
      createdAt: userRow.createdAt.toISOString(),
    },
    company: loaded ? toCompanyDTO(loaded.company, loaded.profile) : null,
    agents: await hydrateDeploymentDTOs(deploymentRows),
  };
  res.json(response);
});

export default router;
