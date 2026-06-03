// Operations lifecycle endpoints — operator-facing UX for registering /
// updating / revoking / closing the Disbursement + Anchor Wallets bound
// to a company.
//
// Architecture matches the rest of features/chain/routes (prepare/confirm
// split): server builds the ix + partial-signs as fee-payer, FE wallet
// adds the owner signature + broadcasts.
//
// One set of endpoints handles BOTH Disbursement and Anchor — caller
// picks which via the `kind` field.

import { Router, type Request, type Response } from "express";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { ERROR_CODES } from "@occa/shared/error-codes";
import {
  OPERATIONS_KIND,
  buildCloseOperationsInstruction,
  buildRegisterCompanyOperationsInstruction,
  buildRevokeOperationsInstruction,
  buildUpdateOperationsCapabilityInstruction,
  deriveOperationsPda,
  type OperationsKind,
} from "@occa/sdk";
import { childLogger } from "../../../lib/logger";
import { requireAuth } from "../../../middleware/auth";
import { findOwnedById as findOwnedCompanyById } from "../../companies/repositories/companies";
import { getOperatorKeypair } from "../../../infra/solana/operator-signer";
import {
  prepareOwnerSignedTx,
  submitSignedTx,
} from "../services/transaction";
import { fetchAllOperationsState } from "../services/operations-lookup";

const log = childLogger("routes:chain:operations");

const router: Router = Router();

// ── Schemas ─────────────────────────────────────────────────────────────────

const kindEnum = z.enum(["disbursement", "anchor"]);

// 8-byte Anchor instruction discriminator, lowercase hex (no 0x prefix).
const hexDisc = z.string().regex(/^[0-9a-f]{16}$/);

const pubkeyStr = z.string().min(32).max(48);

const registerPrepareBody = z
  .object({
    kind: kindEnum,
    signer: pubkeyStr,
    actionWhitelist: z.array(hexDisc).min(1).max(8),
    rateLimitPerPeriod: z.number().int().min(0),
    /** Unix seconds. `0` = no expiry. */
    expiryUnix: z.number().int().min(0),
  })
  .strict();

const updatePrepareBody = z
  .object({
    kind: kindEnum,
    actionWhitelist: z.array(hexDisc).min(1).max(8).optional(),
    rateLimitPerPeriod: z.number().int().min(0).optional(),
    expiryUnix: z.number().int().min(0).optional(),
  })
  .strict();

const lifecycleBody = z.object({ kind: kindEnum }).strict();

const confirmBody = z
  .object({
    kind: kindEnum,
    signedTransaction: z.string().min(1),
    blockhash: z.string().min(32).max(64),
    lastValidBlockHeight: z.number().int().nonnegative(),
  })
  .strict();

// ── Helpers ─────────────────────────────────────────────────────────────────

function kindFromString(s: "disbursement" | "anchor"): OperationsKind {
  return s === "disbursement"
    ? OPERATIONS_KIND.Disbursement
    : OPERATIONS_KIND.Anchor;
}

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

function operatorOrFail(
  res: Response,
): ReturnType<typeof getOperatorKeypair> | null {
  try {
    return getOperatorKeypair();
  } catch (err) {
    log.error({ err }, "operator keypair unavailable");
    res
      .status(StatusCodes.SERVICE_UNAVAILABLE)
      .json({ error: ERROR_CODES.OPERATOR_NOT_CONFIGURED });
    return null;
  }
}

interface OwnedCompanyOrFailResult {
  companyPda: PublicKey;
  ownerWallet: PublicKey;
}

async function ownedCompanyOrFail(
  req: Request,
  res: Response,
): Promise<OwnedCompanyOrFailResult | null> {
  const userId = req.user!.userId;
  const companyId = req.params.companyId;

  const company = await findOwnedCompanyById({ userId, companyId });
  if (!company) {
    res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
    return null;
  }
  if (!company.companyPda) {
    res
      .status(StatusCodes.PRECONDITION_FAILED)
      .json({ error: ERROR_CODES.CHAIN_NOT_ANCHORED });
    return null;
  }
  return {
    companyPda: new PublicKey(company.companyPda),
    ownerWallet: new PublicKey(req.user!.walletAddress),
  };
}

// Shared confirm handler — broadcast the signed tx and return the
// signature. Routes differ only in their log label.
async function broadcastConfirm(
  req: Request,
  res: Response,
  ixName: string,
): Promise<void> {
  const parsed = confirmBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_BODY });
    return;
  }
  const owned = await ownedCompanyOrFail(req, res);
  if (!owned) return;

  try {
    const signature = await submitSignedTx({
      signedTransactionBase64: parsed.data.signedTransaction,
      blockhash: parsed.data.blockhash,
      lastValidBlockHeight: parsed.data.lastValidBlockHeight,
    });
    log.info(
      { companyId: req.params.companyId, kind: parsed.data.kind, signature },
      `${ixName} submitted`,
    );
    res.status(StatusCodes.OK).json({ signature });
  } catch (err) {
    log.error({ err, companyId: req.params.companyId }, `${ixName} submit failed`);
    res.status(StatusCodes.BAD_GATEWAY).json({ error: ERROR_CODES.CHAIN_TX_FAILED });
  }
}

// ── GET — operator pubkey (Phase 1: same key signs ops + fees) ──────────────

router.get(
  "/operator/pubkey",
  requireAuth,
  (_req: Request, res: Response) => {
    const operator = operatorOrFail(res);
    if (!operator) return;
    res.status(StatusCodes.OK).json({ pubkey: operator.publicKey.toBase58() });
  },
);

// ── GET — list both Disbursement + Anchor state ─────────────────────────────

router.get(
  "/companies/:companyId/operations",
  requireAuth,
  async (req: Request, res: Response) => {
    const owned = await ownedCompanyOrFail(req, res);
    if (!owned) return;

    try {
      const operations = await fetchAllOperationsState(owned.companyPda);
      res.status(StatusCodes.OK).json({ operations });
    } catch (err) {
      log.error({ err, companyId: req.params.companyId }, "fetch ops state failed");
      res.status(StatusCodes.BAD_GATEWAY).json({ error: ERROR_CODES.CHAIN_TX_FAILED });
    }
  },
);

// ── register ────────────────────────────────────────────────────────────────

router.post(
  "/companies/:companyId/operations/register/prepare",
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = registerPrepareBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    const owned = await ownedCompanyOrFail(req, res);
    if (!owned) return;
    const operator = operatorOrFail(res);
    if (!operator) return;

    const kind = kindFromString(parsed.data.kind);
    const { instruction } = buildRegisterCompanyOperationsInstruction({
      companyPda: owned.companyPda,
      controllingAuthority: owned.ownerWallet,
      kind,
      signer: new PublicKey(parsed.data.signer),
      actionWhitelist: parsed.data.actionWhitelist.map(hexToBuffer),
      rateLimitPerPeriod: parsed.data.rateLimitPerPeriod,
      expiryUnix: BigInt(parsed.data.expiryUnix),
      payer: operator.publicKey,
    });

    try {
      const prepared = await prepareOwnerSignedTx({
        instructions: [instruction],
        feePayer: operator,
      });
      res.status(StatusCodes.OK).json({
        transaction: prepared.transactionBase64,
        blockhash: prepared.blockhash,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
      });
    } catch (err) {
      log.error({ err, companyId: req.params.companyId }, "ops register prepare failed");
      res.status(StatusCodes.BAD_GATEWAY).json({ error: ERROR_CODES.CHAIN_TX_FAILED });
    }
  },
);

router.post(
  "/companies/:companyId/operations/register/confirm",
  requireAuth,
  (req, res) => broadcastConfirm(req, res, "register_company_operations"),
);

// ── update ──────────────────────────────────────────────────────────────────

router.post(
  "/companies/:companyId/operations/update/prepare",
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = updatePrepareBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    const owned = await ownedCompanyOrFail(req, res);
    if (!owned) return;
    const operator = operatorOrFail(res);
    if (!operator) return;

    const kind = kindFromString(parsed.data.kind);
    const { instruction } = buildUpdateOperationsCapabilityInstruction({
      companyPda: owned.companyPda,
      controllingAuthority: owned.ownerWallet,
      kind,
      actionWhitelist: parsed.data.actionWhitelist?.map(hexToBuffer),
      rateLimitPerPeriod: parsed.data.rateLimitPerPeriod,
      expiryUnix:
        parsed.data.expiryUnix !== undefined
          ? BigInt(parsed.data.expiryUnix)
          : undefined,
    });

    try {
      const prepared = await prepareOwnerSignedTx({
        instructions: [instruction],
        feePayer: operator,
      });
      res.status(StatusCodes.OK).json({
        transaction: prepared.transactionBase64,
        blockhash: prepared.blockhash,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
      });
    } catch (err) {
      log.error({ err, companyId: req.params.companyId }, "ops update prepare failed");
      res.status(StatusCodes.BAD_GATEWAY).json({ error: ERROR_CODES.CHAIN_TX_FAILED });
    }
  },
);

router.post(
  "/companies/:companyId/operations/update/confirm",
  requireAuth,
  (req, res) => broadcastConfirm(req, res, "update_operations_capability"),
);

// ── revoke ──────────────────────────────────────────────────────────────────

router.post(
  "/companies/:companyId/operations/revoke/prepare",
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = lifecycleBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    const owned = await ownedCompanyOrFail(req, res);
    if (!owned) return;
    const operator = operatorOrFail(res);
    if (!operator) return;

    const kind = kindFromString(parsed.data.kind);
    const { instruction } = buildRevokeOperationsInstruction({
      companyPda: owned.companyPda,
      controllingAuthority: owned.ownerWallet,
      kind,
    });

    try {
      const prepared = await prepareOwnerSignedTx({
        instructions: [instruction],
        feePayer: operator,
      });
      res.status(StatusCodes.OK).json({
        transaction: prepared.transactionBase64,
        blockhash: prepared.blockhash,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
      });
    } catch (err) {
      log.error({ err, companyId: req.params.companyId }, "ops revoke prepare failed");
      res.status(StatusCodes.BAD_GATEWAY).json({ error: ERROR_CODES.CHAIN_TX_FAILED });
    }
  },
);

router.post(
  "/companies/:companyId/operations/revoke/confirm",
  requireAuth,
  (req, res) => broadcastConfirm(req, res, "revoke_operations"),
);

// ── close ───────────────────────────────────────────────────────────────────

router.post(
  "/companies/:companyId/operations/close/prepare",
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = lifecycleBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    const owned = await ownedCompanyOrFail(req, res);
    if (!owned) return;
    const operator = operatorOrFail(res);
    if (!operator) return;

    const kind = kindFromString(parsed.data.kind);
    const { instruction } = buildCloseOperationsInstruction({
      companyPda: owned.companyPda,
      controllingAuthority: owned.ownerWallet,
      kind,
    });

    try {
      const prepared = await prepareOwnerSignedTx({
        instructions: [instruction],
        feePayer: operator,
      });
      res.status(StatusCodes.OK).json({
        transaction: prepared.transactionBase64,
        blockhash: prepared.blockhash,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
      });
    } catch (err) {
      log.error({ err, companyId: req.params.companyId }, "ops close prepare failed");
      res.status(StatusCodes.BAD_GATEWAY).json({ error: ERROR_CODES.CHAIN_TX_FAILED });
    }
  },
);

router.post(
  "/companies/:companyId/operations/close/confirm",
  requireAuth,
  (req, res) => broadcastConfirm(req, res, "close_operations"),
);

export default router;
