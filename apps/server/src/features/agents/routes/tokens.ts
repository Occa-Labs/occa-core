// Deployment API key management — mint / list / revoke. Keys are
// short-lived bearer tokens used by an agent's runtime to call back into
// OCCA (e.g. fetch its assigned skills, submit approvals). Owner-scoped:
// only the deployment's owner can mint/revoke.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import type {
  CreateAgentTokenResponse,
  ListAgentTokensResponse,
} from "@occa/shared/types";
import { findAccessibleByUserId } from "../repositories/deployments";
import { requireAuth } from "../../../middleware/auth";
import { createAgentTokenBody } from "../domain/schemas";
import {
  generateDeploymentKey,
  listDeploymentKeys,
  revokeDeploymentKey,
  toDeploymentApiKeyDTO,
} from "../services/deployment-api-keys";

const router: Router = Router();

// POST /api/agents/:id/tokens — mint a new token. Raw key returned once.
router.post("/:id/tokens", requireAuth, async (req: Request, res: Response) => {
  const existing = await findAccessibleByUserId({
    userId: req.user!.userId,
    deploymentId: req.params.id,
  });
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  const parsed = createAgentTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }
  const { rawKey, row } = await generateDeploymentKey({
    deploymentId: existing.id,
    companyId: existing.companyId!,
    name: parsed.data.name,
  });
  const body: CreateAgentTokenResponse = {
    key: toDeploymentApiKeyDTO(row),
    rawKey,
  };
  res.status(StatusCodes.CREATED).json(body);
});

// GET /api/agents/:id/tokens — list (metadata only).
router.get("/:id/tokens", requireAuth, async (req: Request, res: Response) => {
  const existing = await findAccessibleByUserId({
    userId: req.user!.userId,
    deploymentId: req.params.id,
  });
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  const rows = await listDeploymentKeys(existing.id);
  const body: ListAgentTokensResponse = {
    keys: rows.map(toDeploymentApiKeyDTO),
  };
  res.json(body);
});

// DELETE /api/agents/:id/tokens/:tokenId — revoke (soft).
router.delete(
  "/:id/tokens/:tokenId",
  requireAuth,
  async (req: Request, res: Response) => {
    const existing = await findAccessibleByUserId({
      userId: req.user!.userId,
      deploymentId: req.params.id,
    });
    if (!existing) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const ok = await revokeDeploymentKey({
      deploymentId: existing.id,
      keyId: req.params.tokenId,
    });
    if (!ok) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.TOKEN_NOT_FOUND });
      return;
    }
    res.json({ ok: true });
  },
);

export default router;
