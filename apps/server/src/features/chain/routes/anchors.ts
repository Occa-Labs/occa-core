// Anchors read endpoints — operator-facing list of daily Merkle commits
// for a company. Backs the Anchors view in the Chain window.

import { Router, type Request, type Response } from "express";
import { StatusCodes } from "http-status-codes";
import { PublicKey } from "@solana/web3.js";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { childLogger } from "../../../lib/logger";
import { requireAuth } from "../../../middleware/auth";
import { findOwnedById as findOwnedCompanyById } from "../../companies/repositories/companies";
import { listCompanyDailyAnchors } from "../services/daily-anchor-lookup";
import { listCompanyTraceAnchors } from "../services/trace-anchor-lookup";

const log = childLogger("routes:chain:anchors");

const router: Router = Router();

router.get(
  "/companies/:companyId/anchors",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const companyId = req.params.companyId;

    const company = await findOwnedCompanyById({ userId, companyId });
    if (!company) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }
    if (!company.companyPda) {
      // Pre-anchor companies can't have daily anchors yet — return empty.
      res.status(StatusCodes.OK).json({ anchors: [] });
      return;
    }

    try {
      const anchors = await listCompanyDailyAnchors(
        new PublicKey(company.companyPda),
      );
      res.status(StatusCodes.OK).json({ anchors });
    } catch (err) {
      log.error({ err, companyId }, "list daily anchors failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
    }
  },
);

// Per-deliverable provenance commits (commit_trace). Backs the Provenance
// view in the Chain window.
router.get(
  "/companies/:companyId/trace-anchors",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const companyId = req.params.companyId;

    const company = await findOwnedCompanyById({ userId, companyId });
    if (!company) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }
    if (!company.companyPda) {
      res.status(StatusCodes.OK).json({ traces: [] });
      return;
    }

    try {
      const traces = await listCompanyTraceAnchors(
        new PublicKey(company.companyPda),
      );
      res.status(StatusCodes.OK).json({ traces });
    } catch (err) {
      log.error({ err, companyId }, "list trace anchors failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
    }
  },
);

export default router;
