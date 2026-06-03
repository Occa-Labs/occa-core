// Cross-owner marketplace hire — invite + accept handshake.
//
// A company invites an agent owned by another user; the agent's owner
// accepts by signing create_deployment (cross-owner, allowed since the
// registry program update). Lives in the chain feature to reuse the
// on-chain machinery. Mounted at /api/marketplace/invites.

import { Router, type Request, type Response } from "express";
import { StatusCodes } from "http-status-codes";
import { PublicKey } from "@solana/web3.js";
import {
  buildCreateDeploymentInstruction,
  deriveDeploymentPda,
} from "@occa/sdk";
import type {
  InviteStatus,
  MarketplaceInvitesResponse,
} from "@occa/shared/types";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { childLogger } from "../../../lib/logger";
import { requireAuth } from "../../../middleware/auth";
import { getOperatorKeypair } from "../../../infra/solana/operator-signer";
import { prepareOwnerSignedTx, submitSignedTx } from "../services/transaction";
import { nextAgentIndex } from "../repositories/chain-registry";
import {
  createInvite,
  findInviteById,
  setInviteStatus,
  hasPendingInvite,
  listIncomingInvites,
  listOutgoingInvites,
} from "../../agents/repositories/agent-invites";
import {
  findById as findIdentityById,
  findOwnedByUserId as findOwnedIdentityByUserId,
} from "../../agents/repositories/agent-identities";
import {
  listByAgentIdentityId,
  updateDeploymentById,
} from "../../agents/repositories/deployments";
import { updateProfileByDeploymentId } from "../../agents/repositories/agent-runtime-profile";
import {
  findById as findCompanyById,
  findActiveOwnerCompany,
} from "../../companies/repositories/companies";

const router = Router();
const log = childLogger("routes:marketplace-invites");

function operatorOrFail(res: Response) {
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

// The agent's idle deployment row (companyId NULL) — the one that gets
// activated into the hiring company at accept.
async function idleDeploymentFor(identityId: string) {
  const rows = await listByAgentIdentityId(identityId);
  return rows.find((r) => r.companyId === null);
}

// POST /api/marketplace/invites — company owner invites an available agent.
router.post("/", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const targetIdentityId = (
    req.body as { targetIdentityId?: unknown } | undefined
  )?.targetIdentityId;
  const role = (req.body as { role?: unknown } | undefined)?.role;
  if (typeof targetIdentityId !== "string" || typeof role !== "string" || !role) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_BODY });
    return;
  }

  const company = await findActiveOwnerCompany(userId);
  if (!company) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
    return;
  }

  const identity = await findIdentityById(targetIdentityId);
  if (!identity || !identity.availableForWork) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.AGENT_NOT_FOUND });
    return;
  }
  if (identity.ownerUserId === userId) {
    // Own agent → use the normal in-company deploy, not the marketplace.
    res.status(StatusCodes.CONFLICT).json({ error: ERROR_CODES.INVALID_BODY });
    return;
  }
  if (!identity.chainTxSignature || !identity.receivingAddress) {
    res
      .status(StatusCodes.CONFLICT)
      .json({ error: ERROR_CODES.CHAIN_NOT_ANCHORED });
    return;
  }
  if (await hasPendingInvite({ companyId: company.id, targetIdentityId })) {
    res
      .status(StatusCodes.CONFLICT)
      .json({ error: ERROR_CODES.COMPANY_ALREADY_EXISTS });
    return;
  }

  const invite = await createInvite({
    companyId: company.id,
    targetIdentityId,
    role,
    invitedByUserId: userId,
  });
  res.status(StatusCodes.CREATED).json({ inviteId: invite.id });
});

// GET /api/marketplace/invites/incoming — the agent owner's invite inbox.
router.get("/incoming", requireAuth, async (req: Request, res: Response) => {
  const rows = await listIncomingInvites(req.user!.userId);
  const body: MarketplaceInvitesResponse = {
    invites: rows.map((r) => ({
      id: r.id,
      companyName: r.companyName,
      agentName: r.agentName,
      targetIdentityId: r.targetIdentityId,
      role: r.role,
      status: r.status as InviteStatus,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  };
  res.json(body);
});

// GET /api/marketplace/invites/outgoing — the sender's "Sent" view: invites
// this user issued for other owners' agents, with their accept/decline state.
router.get("/outgoing", requireAuth, async (req: Request, res: Response) => {
  const rows = await listOutgoingInvites(req.user!.userId);
  const body: MarketplaceInvitesResponse = {
    invites: rows.map((r) => ({
      id: r.id,
      companyName: r.companyName,
      agentName: r.agentName,
      targetIdentityId: r.targetIdentityId,
      role: r.role,
      status: r.status as InviteStatus,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  };
  res.json(body);
});

// POST /api/marketplace/invites/:id/reject — agent owner declines.
router.post("/:id/reject", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const invite = await findInviteById(req.params.id);
  if (!invite || invite.status !== "pending") {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  const owned = await findOwnedIdentityByUserId({
    userId,
    identityId: invite.targetIdentityId,
  });
  if (!owned) {
    res.status(StatusCodes.FORBIDDEN).json({ error: ERROR_CODES.FORBIDDEN });
    return;
  }
  await setInviteStatus(invite.id, "rejected");
  res.json({ ok: true });
});

// POST /api/marketplace/invites/:id/accept/prepare — build the cross-owner
// create_deployment the agent owner signs.
router.post(
  "/:id/accept/prepare",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const invite = await findInviteById(req.params.id);
    if (!invite || invite.status !== "pending") {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const identity = await findOwnedIdentityByUserId({
      userId,
      identityId: invite.targetIdentityId,
    });
    if (!identity) {
      res.status(StatusCodes.FORBIDDEN).json({ error: ERROR_CODES.FORBIDDEN });
      return;
    }
    if (!identity.identityPda || !identity.chainTxSignature) {
      res
        .status(StatusCodes.CONFLICT)
        .json({ error: ERROR_CODES.CHAIN_NOT_ANCHORED });
      return;
    }
    const company = await findCompanyById(invite.companyId);
    if (!company?.companyPda) {
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }
    const deployment = await idleDeploymentFor(invite.targetIdentityId);
    if (!deployment) {
      // Agent is already working somewhere — can't accept.
      res
        .status(StatusCodes.CONFLICT)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }

    const operator = operatorOrFail(res);
    if (!operator) return;

    const deploymentIndex = await nextAgentIndex(company.id);
    const ownerWalletPk = new PublicKey(req.user!.walletAddress);
    const { instruction } = buildCreateDeploymentInstruction({
      companyPda: new PublicKey(company.companyPda),
      identityPda: new PublicKey(identity.identityPda),
      owner: ownerWalletPk,
      payer: operator.publicKey,
      deploymentIndex,
      role: invite.role,
      adapterId: PublicKey.default,
      metadataUri: "",
      metadataHash: Buffer.alloc(32),
    });

    let prepared: Awaited<ReturnType<typeof prepareOwnerSignedTx>>;
    try {
      prepared = await prepareOwnerSignedTx({
        instructions: [instruction],
        feePayer: operator,
      });
    } catch (err) {
      log.error({ err, inviteId: invite.id }, "accept invite prepare failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    res.status(StatusCodes.OK).json({
      transaction: prepared.transactionBase64,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
      deploymentIndex,
    });
  },
);

// POST /api/marketplace/invites/:id/accept/confirm — submit the signed tx;
// activate the agent's deployment into the hiring company.
router.post(
  "/:id/accept/confirm",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const body = (req.body ?? {}) as {
      signedTransaction?: unknown;
      blockhash?: unknown;
      lastValidBlockHeight?: unknown;
      deploymentIndex?: unknown;
    };
    if (
      typeof body.signedTransaction !== "string" ||
      typeof body.blockhash !== "string" ||
      typeof body.lastValidBlockHeight !== "number" ||
      typeof body.deploymentIndex !== "number"
    ) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }

    const invite = await findInviteById(req.params.id);
    if (!invite || invite.status !== "pending") {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const identity = await findOwnedIdentityByUserId({
      userId,
      identityId: invite.targetIdentityId,
    });
    if (!identity) {
      res.status(StatusCodes.FORBIDDEN).json({ error: ERROR_CODES.FORBIDDEN });
      return;
    }
    const company = await findCompanyById(invite.companyId);
    if (!company?.companyPda) {
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }
    const deployment = await idleDeploymentFor(invite.targetIdentityId);
    if (!deployment) {
      res.status(StatusCodes.CONFLICT).json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }

    let signature: string;
    try {
      signature = await submitSignedTx({
        signedTransactionBase64: body.signedTransaction,
        blockhash: body.blockhash,
        lastValidBlockHeight: body.lastValidBlockHeight,
      });
    } catch (err) {
      log.error({ err, inviteId: invite.id }, "accept invite submit failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    const { pda: deploymentPda } = deriveDeploymentPda(
      new PublicKey(company.companyPda),
      body.deploymentIndex,
    );

    await updateDeploymentById({
      deploymentId: deployment.id,
      patch: {
        companyId: company.id,
        role: invite.role,
        deploymentIndex: body.deploymentIndex,
        deploymentPda: deploymentPda.toBase58(),
        receivingAddress: identity.receivingAddress,
        chainTxSignature: signature,
      },
    });
    // Keep the runtime profile's company scope in sync so dispatch + skill
    // flows treat the agent as working in the hiring company.
    await updateProfileByDeploymentId({
      deploymentId: deployment.id,
      patch: { companyId: company.id },
    });
    await setInviteStatus(invite.id, "accepted");

    log.info(
      {
        inviteId: invite.id,
        deploymentId: deployment.id,
        companyId: company.id,
        signature,
      },
      "marketplace invite accepted — agent deployed cross-owner",
    );

    res.status(StatusCodes.OK).json({ deploymentId: deployment.id, signature });
  },
);

export default router;
