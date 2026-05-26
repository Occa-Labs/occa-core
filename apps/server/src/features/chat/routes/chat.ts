// Chat surface routes (Phase 2.5 of the hierarchical agent system).
// User talks to the company's CEO; everything else (Heads + specialists)
// is reached transitively. Mounted under /api/chat.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import type {
  ChatMessageDTO,
  ChatMessageRole,
  ListChatMessagesResponse,
  SendChatMessageResponse,
} from "@occa/shared/types";
import { childLogger } from "../../../lib/logger";
import { requireAuth } from "../../../middleware/auth";
import { getAdapter } from "../../../lib/adapter-registry";
import { threadSessionKey } from "../../../lib/session-keys";
import { userCompanyId } from "../../tasks/routes/helpers";
import { findCeoForCompany } from "../../agents/repositories/deployments";
import { findByDeploymentId as findRuntimeProfile } from "../../agents/repositories/agent-runtime-profile";
import {
  clearThread,
  listMessages,
  type ChatMessageRow,
} from "../repositories/chat-messages";
import {
  bumpThreadResetGeneration,
  resolveUserCeoThreadId,
} from "../repositories/chat-threads";
import { sendChatMessageBody } from "../domain/schemas";
import { sendUserTurn } from "../services/chat-handler";

const log = childLogger("routes:chat");

const router: Router = Router();

function toDTO(row: ChatMessageRow): ChatMessageDTO {
  return {
    id: row.id,
    role: row.role as ChatMessageRole,
    content: row.content,
    createdTaskId: row.createdTaskId ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

router.get("/ceo", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const ceo = await findCeoForCompany(companyId);
  if (!ceo) {
    // Returning an empty list (instead of an error) keeps the FE contract
    // simple: the chat panel renders the "deploy a CEO first" nudge based
    // on the agent list it already has, then this route just returns [].
    const empty: ListChatMessagesResponse = { messages: [] };
    res.json(empty);
    return;
  }
  const rows = await listMessages({
    companyId,
    deploymentId: ceo.id,
  });
  const out: ListChatMessagesResponse = { messages: rows.map(toDTO) };
  res.json(out);
});

// Wipe the current chat thread. Both the DB rows AND the gateway-side
// conversation memory are reset: the session key is now stable per
// thread id (no boundary suffix), so a clear must explicitly delete the
// gateway session — otherwise the CEO would keep its old memory and the
// "fresh start" the user expects wouldn't happen.
router.delete("/ceo", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const ceo = await findCeoForCompany(companyId);
  if (!ceo) {
    // No CEO = nothing to clear; treat as success so the FE can still
    // render an empty thread without surfacing an error.
    res.status(StatusCodes.NO_CONTENT).end();
    return;
  }

  // Two-step reset, best-effort on both:
  //   1. Adapters that own a server-side session-delete (OpenClaw) get
  //      `resetSession` called against the CURRENT generation's session
  //      key so the running gateway session is dropped.
  //   2. The thread's reset_generation is bumped so the NEXT adapter call
  //      derives a brand-new sessionKey. That's the only mechanism that
  //      breaks continuity for adapters without an HTTP session-delete
  //      (Hermes — the old session sits in its store until prune cron
  //      reaps it, but OCCA never addresses that key again).
  // A failure in either step shouldn't block the user from clearing
  // their local thread.
  const profile = await findRuntimeProfile(ceo.id);
  if (profile?.externalAgentId) {
    try {
      const { id: threadId, resetGeneration } = await resolveUserCeoThreadId({
        companyId,
        ceoDeploymentId: ceo.id,
      });
      const adapter = getAdapter(profile.adapterType);
      if (adapter) {
        const result = await adapter.resetSession({
          adapterConfig: (profile.adapterConfig ?? {}) as Record<
            string,
            unknown
          >,
          sessionKey: threadSessionKey(
            profile.externalAgentId,
            threadId,
            resetGeneration,
          ),
        });
        if (!result.ok) {
          req.log.warn(
            { ceoId: ceo.id, error: result.error },
            "resetSession failed on thread clear (non-fatal)",
          );
        }
      }
      await bumpThreadResetGeneration(threadId);
    } catch (err) {
      req.log.warn(
        { err, ceoId: ceo.id },
        "thread reset cleanup failed (non-fatal)",
      );
    }
  }

  await clearThread({ companyId, deploymentId: ceo.id });
  res.status(StatusCodes.NO_CONTENT).end();
});

router.post("/ceo", requireAuth, async (req: Request, res: Response) => {
  const parsed = sendChatMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_BODY,
      detail: parsed.error.flatten(),
    });
    return;
  }
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }

  const result = await sendUserTurn({
    companyId,
    userId: req.user!.userId,
    content: parsed.data.content,
  });

  switch (result.kind) {
    case "no_ceo":
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.NO_CEO_DEPLOYED,
        reason: "Deploy a CEO agent before talking to it.",
      });
      return;
    case "agent_not_configured":
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.AGENT_NOT_CONFIGURED });
      return;
    case "agent_not_provisioned":
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.AGENT_NOT_PROVISIONED });
      return;
    case "adapter_failed":
      // Adapter-failed surfaces as a system message (already inserted)
      // rather than an HTTP error — the FE renders it inline so the user
      // sees what happened without a toast.
      log.warn(
        { companyId },
        "CEO adapter call failed; system message returned to UI",
      );
      res.status(StatusCodes.CREATED).json({
        user: toDTO(result.user),
        assistant: toDTO(result.assistant),
        createdTask: null,
      } satisfies SendChatMessageResponse);
      return;
    case "ok":
      res.status(StatusCodes.CREATED).json({
        user: toDTO(result.user),
        assistant: toDTO(result.assistant),
        createdTask: result.createdTask,
      } satisfies SendChatMessageResponse);
      return;
  }
});

export default router;
