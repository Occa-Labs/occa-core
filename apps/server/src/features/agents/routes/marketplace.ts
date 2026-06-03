// Cross-owner agent marketplace. Lists agents whose owners opted into
// `available_for_work`, are anchored on-chain, and are currently idle, so
// other companies can discover + (Phase 4b) invite them. Read-only here.

import { Router, type Request, type Response } from "express";
import type { MarketplaceAgentsResponse } from "@occa/shared/types";
import { requireAuth } from "../../../middleware/auth";
import { listMarketplaceAgents } from "../repositories/agent-identities";

const router = Router();

// GET /api/marketplace/agents — the public directory of available agents.
router.get("/agents", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const rows = await listMarketplaceAgents();
  const body: MarketplaceAgentsResponse = {
    agents: rows.map((r) => ({
      identityId: r.identityId,
      name: r.name,
      persona: r.persona,
      role: r.role,
      ownerWallet: r.ownerWallet,
      // Query guarantees these are set (anchored + receiving wallet
      // present), but the row types stay nullable — fall back defensively.
      identityPda: r.identityPda,
      receivingWallet: r.receivingAddress ?? "",
      isOwn: r.ownerUserId === userId,
      createdAt: r.createdAt.toISOString(),
    })),
  };
  res.json(body);
});

export default router;
