// Read-only inbox routes for the OS "Chats" window. Exposes the
// observer-style view across `user_ceo` + `agent_dm` threads:
//
//   GET /api/chat/inbox/partners?self=user
//   GET /api/chat/inbox/partners?self=agent:<deploymentId>
//   GET /api/chat/inbox/messages?self=<party>&partner=<party>
//
// Authorization: every deployment referenced in `self` or `partner` is
// validated to belong to the auth user's company before the repo call
// runs, so an attacker can't probe foreign companies via the API.

import { Router, type Request, type Response } from "express";
import { StatusCodes } from "http-status-codes";
import { ERROR_CODES } from "@occa/shared/error-codes";
import type {
  ChatMessageRole,
  InboxMessageDTO,
  InboxPartySummaryDTO,
  ListInboxMessagesResponse,
  ListInboxPartnersResponse,
} from "@occa/shared/types";

import { requireAuth } from "../../../middleware/auth";
import { userCompanyId } from "../../tasks/routes/helpers";
import { findByIdInCompany } from "../../agents/repositories/deployments";
import {
  listMessagesBetween,
  listPartnersForAgent,
  listPartnersForUser,
  type InboxMessageRow,
  type InboxPartnerSummary,
  type InboxPartyKind,
} from "../repositories/chat-inbox";
import {
  listInboxMessagesQuery,
  listInboxPartnersQuery,
  type InboxPartySpec,
} from "../domain/schemas";

const router: Router = Router();

function partnerToDTO(p: InboxPartnerSummary): InboxPartySummaryDTO {
  return {
    kind: p.kind,
    id: p.id,
    lastMessageAt: p.lastMessageAt.toISOString(),
    lastMessagePreview: p.lastMessageContent,
    lastMessageRole: p.lastMessageRole as ChatMessageRole,
    threadCount: p.threadCount,
  };
}

function messageToDTO(m: InboxMessageRow): InboxMessageDTO {
  return {
    id: m.id,
    threadId: m.threadId,
    threadKind: m.threadKind,
    role: m.role as ChatMessageRole,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    senderKind: m.senderKind,
    senderId: m.senderId,
    createdTaskId: m.createdTaskId,
  };
}

// Resolve an InboxPartySpec to (kind, id) — id is the auth userId when
// party=user; otherwise the validated deploymentId within the auth user's
// company. Returns null when a deployment is referenced but not owned by
// the company (caller surfaces 404).
async function resolveParty(args: {
  party: InboxPartySpec;
  userId: string;
  companyId: string;
}): Promise<{ kind: InboxPartyKind; id: string } | null> {
  if (args.party.kind === "user") {
    return { kind: "user", id: args.userId };
  }
  const dep = await findByIdInCompany({
    deploymentId: args.party.id,
    companyId: args.companyId,
  });
  if (!dep) return null;
  return { kind: "deployment", id: dep.id };
}

router.get(
  "/inbox/partners",
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = listInboxPartnersQuery.safeParse({ self: req.query.self });
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.INVALID_QUERY,
        detail: parsed.error.flatten(),
      });
      return;
    }
    const companyId = await userCompanyId(req.user!.userId);
    if (!companyId) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
      return;
    }

    const { self } = parsed.data;
    let partners: InboxPartnerSummary[];
    if (self.kind === "user") {
      partners = await listPartnersForUser({
        companyId,
        userId: req.user!.userId,
      });
    } else {
      const dep = await findByIdInCompany({
        deploymentId: self.id,
        companyId,
      });
      if (!dep) {
        res
          .status(StatusCodes.NOT_FOUND)
          .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
        return;
      }
      partners = await listPartnersForAgent({
        companyId,
        selfDeploymentId: dep.id,
      });
    }
    const out: ListInboxPartnersResponse = {
      partners: partners.map(partnerToDTO),
    };
    res.json(out);
  },
);

router.get(
  "/inbox/messages",
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = listInboxMessagesQuery.safeParse({
      self: req.query.self,
      partner: req.query.partner,
    });
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.INVALID_QUERY,
        detail: parsed.error.flatten(),
      });
      return;
    }
    const companyId = await userCompanyId(req.user!.userId);
    if (!companyId) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
      return;
    }

    const { self, partner } = parsed.data;
    const selfResolved = await resolveParty({
      party: self,
      userId: req.user!.userId,
      companyId,
    });
    if (!selfResolved) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }
    const partnerResolved = await resolveParty({
      party: partner,
      userId: req.user!.userId,
      companyId,
    });
    if (!partnerResolved) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }

    const messages = await listMessagesBetween({
      companyId,
      selfKind: selfResolved.kind,
      selfId: selfResolved.id,
      partnerKind: partnerResolved.kind,
      partnerId: partnerResolved.id,
    });
    const out: ListInboxMessagesResponse = {
      messages: messages.map(messageToDTO),
    };
    res.json(out);
  },
);

export default router;
