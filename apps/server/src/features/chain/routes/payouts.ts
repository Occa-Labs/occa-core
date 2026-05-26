// Routine payouts endpoint — trigger the autonomous disburse_routine
// engine for one company. No FE wallet popup; the engine signs with the
// operator keypair (which Phase 1 expects to ALSO be the Disbursement
// Wallet signer of this company's OperationsAccount).
//
// Cron-driven invocation lands in a follow-up slice. This endpoint
// covers manual operator-initiated runs + serves as the integration
// surface the cron job will call.

import { Router, type Request, type Response } from "express";
import { StatusCodes } from "http-status-codes";
import { PublicKey } from "@solana/web3.js";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { childLogger } from "../../../lib/logger";
import { requireAuth } from "../../../middleware/auth";
import { findOwnedById as findOwnedCompanyById } from "../../companies/repositories/companies";
import {
  PayoutPreconditionError,
  runRoutinePayouts,
} from "../../billing/services/payout-engine";

const log = childLogger("routes:chain:payouts");

const router: Router = Router();

/**
 * POST /api/chain/companies/:companyId/payouts/run
 *
 * Execute all pending routine payouts for this company in one batch.
 * Each agent's invoices get one disburse_routine tx; failures are
 * isolated per-tx (one bad payout doesn't block the others).
 *
 * Returns a summary with per-agent results (signature or error).
 */
router.post(
  "/companies/:companyId/payouts/run",
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
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({ error: ERROR_CODES.CHAIN_NOT_ANCHORED });
      return;
    }

    try {
      const summary = await runRoutinePayouts({
        companyId,
        companyPda: new PublicKey(company.companyPda),
      });
      res.status(StatusCodes.OK).json(summary);
    } catch (err) {
      if (err instanceof PayoutPreconditionError) {
        log.warn(
          { code: err.code, message: err.message, companyId },
          "payout precondition failed",
        );
        res.status(StatusCodes.PRECONDITION_FAILED).json({
          error: err.code,
          detail: err.message,
        });
        return;
      }
      log.error({ err, companyId }, "payout run failed");
      res
        .status(StatusCodes.INTERNAL_SERVER_ERROR)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
    }
  },
);

export default router;
