// Company-wide on-chain transaction list. Read-only — backs the
// Transactions view in the Chain window.

import { Router, type Request, type Response } from "express";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { childLogger } from "../../../lib/logger";
import { requireAuth } from "../../../middleware/auth";
import { findOwnedById as findOwnedCompanyById } from "../../companies/repositories/companies";
import { listCompanyTransactions } from "../services/transactions-aggregator";

const log = childLogger("routes:chain:transactions");

const router: Router = Router();

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.string().min(32).max(96).optional(),
});

router.get(
  "/companies/:companyId/transactions",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const companyId = req.params.companyId;

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }

    const company = await findOwnedCompanyById({ userId, companyId });
    if (!company) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }
    if (!company.companyPda) {
      // Pre-anchor companies have no on-chain footprint yet — return
      // empty list rather than 412 so the FE can render an empty state.
      res.status(StatusCodes.OK).json({ records: [], hasMore: false });
      return;
    }

    try {
      const result = await listCompanyTransactions({
        companyPda: new PublicKey(company.companyPda),
        companyId,
        limit: parsed.data.limit,
        before: parsed.data.before,
      });
      res.status(StatusCodes.OK).json(result);
    } catch (err) {
      log.error({ err, companyId }, "list transactions failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
    }
  },
);

export default router;
