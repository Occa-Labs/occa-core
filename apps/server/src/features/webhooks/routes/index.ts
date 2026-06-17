// Operator-facing CRUD for a company's webhooks. Mounted under
// /api/companies/:companyId/webhooks with mergeParams so handlers can read
// `req.params.companyId` from the parent URL.
//
// Endpoints:
//   GET    /                list the company's webhooks
//   POST   /                create one
//   PATCH  /:webhookId      update name / url / secret / enabled
//   DELETE /:webhookId      remove it
//
// Ownership: every handler resolves the parent company via the auth user
// before touching anything, so a user can't manage another company's
// webhooks by guessing IDs. The secret is write-only — never returned.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import type {
  ListWebhooksResponse,
  WebhookResponse,
  WebhookTestResponse,
} from "@occa/shared/types";
import { requireAuth } from "../../../middleware/auth";
import { findOwnedById as findOwnedCompanyById } from "../../companies/repositories/companies";
import { createWebhookBody, updateWebhookBody } from "../domain/schemas";
import { toWebhookDTO } from "../domain/dto";
import { sendTestDelivery } from "../services/test-delivery";
import {
  create as createWebhook,
  deleteById as deleteWebhook,
  findByIdForCompany,
  listByCompany,
  updateById as updateWebhook,
} from "../repositories/webhooks";

const router: Router = Router({ mergeParams: true });

// Resolve and authorize the parent company. Returns its id, or null after
// having already written a 404 — callers just `return` on null.
async function resolveCompanyId(
  req: Request,
  res: Response,
): Promise<string | null> {
  const userId = req.user!.userId;
  const companyId = (req.params as { companyId?: string }).companyId ?? "";
  const company = await findOwnedCompanyById({ userId, companyId });
  if (!company) {
    res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
    return null;
  }
  return company.id;
}

router.get("/", requireAuth, async (req: Request, res: Response) => {
  const companyId = await resolveCompanyId(req, res);
  if (!companyId) return;
  const rows = await listByCompany(companyId);
  const payload: ListWebhooksResponse = { webhooks: rows.map(toWebhookDTO) };
  res.json(payload);
});

router.post("/", requireAuth, async (req: Request, res: Response) => {
  const companyId = await resolveCompanyId(req, res);
  if (!companyId) return;

  const parsed = createWebhookBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_BODY,
      detail: parsed.error.flatten(),
    });
    return;
  }

  const row = await createWebhook({
    companyId,
    name: parsed.data.name,
    targetUrl: parsed.data.targetUrl,
    secret: parsed.data.secret,
    enabled: parsed.data.enabled ?? true,
  });
  const payload: WebhookResponse = { webhook: toWebhookDTO(row) };
  res.status(StatusCodes.CREATED).json(payload);
});

router.patch(
  "/:webhookId",
  requireAuth,
  async (req: Request, res: Response) => {
    const companyId = await resolveCompanyId(req, res);
    if (!companyId) return;

    const existing = await findByIdForCompany({
      id: req.params.webhookId,
      companyId,
    });
    if (!existing) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }

    const parsed = updateWebhookBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.INVALID_BODY,
        detail: parsed.error.flatten(),
      });
      return;
    }

    if (Object.keys(parsed.data).length === 0) {
      res.json({ webhook: toWebhookDTO(existing) } satisfies WebhookResponse);
      return;
    }

    const row = await updateWebhook({ id: existing.id, patch: parsed.data });
    const payload: WebhookResponse = { webhook: toWebhookDTO(row) };
    res.json(payload);
  },
);

// POST /:webhookId/test — fire a synthetic delivery now. Records health like
// any real delivery. Resolves the full company row for the payload's name.
router.post(
  "/:webhookId/test",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const companyId = (req.params as { companyId?: string }).companyId ?? "";
    const company = await findOwnedCompanyById({ userId, companyId });
    if (!company) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }

    const webhook = await findByIdForCompany({
      id: req.params.webhookId,
      companyId: company.id,
    });
    if (!webhook) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }

    const result = await sendTestDelivery({
      webhook,
      company: { id: company.id, name: company.name },
    });
    const payload: WebhookTestResponse = {
      ok: result.ok,
      status: result.status,
      response: result.response,
    };
    res.json(payload);
  },
);

router.delete(
  "/:webhookId",
  requireAuth,
  async (req: Request, res: Response) => {
    const companyId = await resolveCompanyId(req, res);
    if (!companyId) return;

    const existing = await findByIdForCompany({
      id: req.params.webhookId,
      companyId,
    });
    if (!existing) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }

    await deleteWebhook(existing.id);
    res.status(StatusCodes.NO_CONTENT).end();
  },
);

export default router;
