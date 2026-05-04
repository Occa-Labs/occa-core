import { Router, type Request, type Response } from "express";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { ERROR_CODES } from "@occa/shared/error-codes";
import {
  buildAgentDerivationMessage,
  buildCreateCompanyInstruction,
  buildRegisterAgentInstruction,
  CURRENT_DERIVATION_MSG_VERSION,
  custodyModelStringToU8,
  CUSTODY_MODEL,
  deriveCompanyPda,
} from "@occa/protocol";
import { childLogger } from "../../../lib/logger";
import { requireAuth } from "../../../middleware/auth";
import { findOwnedById as findOwnedCompanyById } from "../../companies/repositories/companies";
import { findOwnedByUserId as findOwnedAgentByUserId } from "../../agents/repositories/agents";
import { findById as findCompanyById } from "../../companies/repositories/companies";
import { getOperatorKeypair } from "../../../infra/solana/operator-signer";
import { verifySolanaSignature } from "../../../infra/solana/verify";
import {
  accountExists,
  sendAndConfirmInstruction,
} from "../services/transaction";
import {
  nextAgentIndex,
  nextChainNonce,
  persistAgentChainRegistration,
  persistCompanyChainRegistration,
} from "../repositories/chain-registry";

const log = childLogger("routes:chain");

const router: Router = Router();

// ── Schemas ─────────────────────────────────────────────────────────────────

const registerCompanyBody = z
  .object({
    metadataUri: z.string().max(200).optional(),
  })
  .strict();

const registerAgentBody = z
  .object({
    agentAddress: z.string().min(32).max(64),
    derivationSignature: z.string().min(64).max(128),
    derivationMessageVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/chain/companies/:companyId/register
 *
 * Register the caller's company on-chain (create_company). Operator hot
 * wallet acts as `controlling_authority` + payer for MVP. Idempotent: if
 * the company already has `company_pda` set, returns 200 with existing
 * record.
 */
router.post(
  "/companies/:companyId/register",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const companyId = req.params.companyId;

    const parsed = registerCompanyBody.safeParse(req.body ?? {});
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

    if (company.companyPda) {
      res.status(StatusCodes.OK).json({
        alreadyRegistered: true,
        companyPda: company.companyPda,
        controllingAuthority: company.controllingAuthority,
        chainNonce: company.chainNonce,
        chainTxSignature: company.chainTxSignature,
      });
      return;
    }

    const operator = operatorOrFail(res);
    if (!operator) return;

    const authority = operator.publicKey;
    const metadataUri = parsed.data.metadataUri ?? "";

    // Pick an unused nonce — start from DB max+1 and probe on-chain to
    // skip any collisions left behind by partial failures.
    let nonce = await nextChainNonce(authority.toBase58());
    let companyPda: PublicKey | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const derived = deriveCompanyPda(authority, nonce);
      // eslint-disable-next-line no-await-in-loop
      const exists = await accountExists(derived.pda);
      if (!exists) {
        companyPda = derived.pda;
        break;
      }
      nonce += 1;
    }
    if (!companyPda) {
      res
        .status(StatusCodes.CONFLICT)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    const { instruction } = buildCreateCompanyInstruction({
      authority,
      payer: authority,
      nonce,
      metadataUri,
    });

    let signature: string;
    try {
      signature = await sendAndConfirmInstruction({
        instruction,
        payer: operator,
      });
    } catch (err) {
      log.error({ err, companyId, nonce }, "create_company failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    await persistCompanyChainRegistration({
      companyId,
      companyPda: companyPda.toBase58(),
      controllingAuthority: authority.toBase58(),
      chainNonce: nonce,
      chainTxSignature: signature,
    });

    log.info(
      { companyId, companyPda: companyPda.toBase58(), nonce, signature },
      "company registered on-chain",
    );

    res.status(StatusCodes.OK).json({
      alreadyRegistered: false,
      companyPda: companyPda.toBase58(),
      controllingAuthority: authority.toBase58(),
      chainNonce: nonce,
      chainTxSignature: signature,
    });
  },
);

/**
 * POST /api/chain/agents/:agentId/register
 *
 * Register an agent on-chain (register_agent). Body carries the
 * FE-derived `agentAddress` plus the wallet signature over the canonical
 * derivation message — server verifies the signature against the user's
 * own walletAddress before submitting on-chain.
 *
 * Custody model is pinned to `sign_to_derive` (MVP). Operator hot wallet
 * signs as `controlling_authority` (matches whoever created the company).
 */
router.post(
  "/agents/:agentId/register",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const userWallet = req.user!.walletAddress;
    const agentId = req.params.agentId;

    const parsed = registerAgentBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    const { agentAddress, derivationSignature } = parsed.data;
    const derivationMessageVersion =
      parsed.data.derivationMessageVersion ?? CURRENT_DERIVATION_MSG_VERSION;

    const agent = await findOwnedAgentByUserId({ userId, agentId });
    if (!agent) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }

    if (agent.agentPda) {
      res.status(StatusCodes.OK).json({
        alreadyRegistered: true,
        agentPda: agent.agentPda,
        agentAddress: agent.agentAddress,
        agentIndex: agent.agentIndex,
        agentChainTxSignature: agent.agentChainTxSignature,
      });
      return;
    }

    // Company must already be on-chain — register company first.
    const companyRow = await findCompanyById(agent.companyId);
    if (!companyRow || !companyRow.companyPda) {
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }

    // Validate agentAddress is a valid pubkey before signature work.
    let agentPubkey: PublicKey;
    try {
      agentPubkey = new PublicKey(agentAddress);
    } catch {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }

    // Pick agent_index, probing on-chain for collisions.
    const companyPda = new PublicKey(companyRow.companyPda);
    let agentIndex = await nextAgentIndex(agent.companyId);
    let agentPda: PublicKey | null = null;
    {
      const { buildRegisterAgentInstruction: _b } =
        await import("@occa/protocol");
      void _b;
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const probe = buildRegisterAgentInstruction({
        companyPda,
        controllingAuthority: getOperatorKeypair().publicKey,
        payer: getOperatorKeypair().publicKey,
        agentIndex,
        agentAddress: agentPubkey,
        custodyModel: custodyModelStringToU8(CUSTODY_MODEL.SignToDerive),
        roleId: 0,
        adapterId: PublicKey.default,
      });
      // eslint-disable-next-line no-await-in-loop
      const exists = await accountExists(probe.agentPda);
      if (!exists) {
        agentPda = probe.agentPda;
        break;
      }
      agentIndex += 1;
    }
    if (!agentPda) {
      res
        .status(StatusCodes.CONFLICT)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    // Verify the user's wallet signed the canonical derivation message
    // for THIS (companyPda, agentIndex). This binds `agentAddress` to the
    // user's wallet — preventing them from registering a random pubkey.
    const message = buildAgentDerivationMessage({
      companyPda: companyPda.toBase58(),
      agentIndex,
      version: derivationMessageVersion,
    });
    const sigOk = await verifySolanaSignature(
      userWallet,
      derivationSignature,
      message,
    );
    if (!sigOk) {
      res
        .status(StatusCodes.UNAUTHORIZED)
        .json({ error: ERROR_CODES.SIGNATURE_INVALID });
      return;
    }

    const operator = operatorOrFail(res);
    if (!operator) return;

    const { instruction } = buildRegisterAgentInstruction({
      companyPda,
      controllingAuthority: operator.publicKey,
      payer: operator.publicKey,
      agentIndex,
      agentAddress: agentPubkey,
      custodyModel: custodyModelStringToU8(CUSTODY_MODEL.SignToDerive),
      roleId: 0,
      adapterId: PublicKey.default,
    });

    let signature: string;
    try {
      signature = await sendAndConfirmInstruction({
        instruction,
        payer: operator,
      });
    } catch (err) {
      log.error({ err, agentId, agentIndex }, "register_agent failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    await persistAgentChainRegistration({
      agentId,
      agentPda: agentPda.toBase58(),
      agentAddress: agentPubkey.toBase58(),
      agentIndex,
      custodyModel: CUSTODY_MODEL.SignToDerive,
      derivationMsgVersion: derivationMessageVersion,
      agentChainTxSignature: signature,
    });

    log.info(
      { agentId, agentPda: agentPda.toBase58(), agentIndex, signature },
      "agent registered on-chain",
    );

    res.status(StatusCodes.OK).json({
      alreadyRegistered: false,
      agentPda: agentPda.toBase58(),
      agentAddress: agentPubkey.toBase58(),
      agentIndex,
      derivationMessageVersion,
      agentChainTxSignature: signature,
    });
  },
);

export default router;
