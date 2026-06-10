// Chat surface routes (Phase 2.5 of the hierarchical agent system).
// User talks to the company's CEO; everything else (Heads + specialists)
// is reached transitively. Mounted under /api/chat.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import type {
  ApprovalActionType,
  ApprovalStatus,
  ChatMessageDTO,
  ChatMessageRole,
  ListChatMessagesResponse,
  SendChatMessageResponse,
  TraceUsage,
} from "@occa/shared/types";
import { childLogger } from "../../../lib/logger";
import { requireAuth } from "../../../middleware/auth";
import { getAdapter } from "../../../lib/adapter-registry";
import { threadSessionKey } from "../../../lib/session-keys";
import { userCompanyId } from "../../tasks/routes/helpers";
import {
  findCeoForCompany,
  findOwnedByUserId,
} from "../../agents/repositories/deployments";
import { findByDeploymentId as findRuntimeProfile } from "../../agents/repositories/agent-runtime-profile";
import {
  findLinkedApprovals,
  findTraceUsages,
  listMessages,
  listSessions,
  type ChatMessageRow,
  type LinkedApprovalRow,
} from "../repositories/chat-messages";
import {
  bumpThreadResetGeneration,
  getThreadResetGeneration,
  resolveUserCeoThreadId,
  resolveUserAgentThreadId,
} from "../repositories/chat-threads";
import { sendChatMessageBody } from "../domain/schemas";
import { sendUserTurn } from "../services/chat-handler";

const log = childLogger("routes:chat");

const router: Router = Router();

// `?generation=N` selects a specific session (reset_generation) for the
// History read-only view. Absent / invalid → undefined (caller defaults to
// the thread's current generation = the active chat).
function parseGenerationQuery(q: unknown): number | undefined {
  if (typeof q !== "string") return undefined;
  const n = Number(q);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function toDTO(
  row: ChatMessageRow,
  approval: LinkedApprovalRow | undefined,
  usage: TraceUsage | undefined,
): ChatMessageDTO {
  return {
    id: row.id,
    role: row.role as ChatMessageRole,
    content: row.content,
    createdTaskId: row.createdTaskId ?? null,
    linkedApproval: approval
      ? {
          id: approval.id,
          actionType: approval.actionType as ApprovalActionType,
          payload: approval.payload ?? {},
          status: approval.status as ApprovalStatus,
        }
      : null,
    usage: usage ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// Map message rows to DTOs, batch-resolving linked approvals (inline
// Approve/Reject cards) and per-turn usage (per-bubble token/cost) so the
// chat renders both in the same fetch.
async function serializeMessages(
  rows: ChatMessageRow[],
): Promise<ChatMessageDTO[]> {
  const approvalIds = rows
    .map((r) => r.linkedApprovalId)
    .filter((id): id is string => id !== null);
  const traceIds = rows
    .map((r) => r.traceId)
    .filter((id): id is string => id !== null);
  const [approvalsById, usageByTrace] = await Promise.all([
    findLinkedApprovals(approvalIds),
    findTraceUsages(traceIds),
  ]);
  return rows.map((r) =>
    toDTO(
      r,
      r.linkedApprovalId
        ? approvalsById.get(r.linkedApprovalId)
        : undefined,
      r.traceId ? usageByTrace.get(r.traceId) : undefined,
    ),
  );
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
  const generation =
    parseGenerationQuery(req.query.generation) ??
    (await getThreadResetGeneration({
      companyId,
      deploymentId: ceo.id,
      kind: "user_ceo",
    }));
  const rows = await listMessages({
    companyId,
    deploymentId: ceo.id,
    generation,
  });
  const out: ListChatMessagesResponse = {
    messages: await serializeMessages(rows),
  };
  res.json(out);
});

// GET /ceo/sessions — list past + current sessions for the History dropdown.
router.get("/ceo/sessions", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const ceo = await findCeoForCompany(companyId);
  if (!ceo) {
    res.json({ sessions: [], currentGeneration: 0 });
    return;
  }
  const [sessions, currentGeneration] = await Promise.all([
    listSessions({ companyId, deploymentId: ceo.id }),
    getThreadResetGeneration({ companyId, deploymentId: ceo.id, kind: "user_ceo" }),
  ]);
  res.json({ sessions, currentGeneration });
});

// Start a NEW session. Prior messages are NOT deleted — they stay tagged
// with the old reset_generation so History can browse them. We bump the
// thread's reset_generation (the active chat moves to a fresh, empty
// generation) and reset the gateway-side conversation memory so the agent
// also starts fresh. Best-effort on the gateway reset.
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
  } else {
    // No runtime profile yet (rare) — still advance the session so the UI
    // starts a fresh generation. Resolve creates the thread if needed.
    const { id: threadId } = await resolveUserCeoThreadId({
      companyId,
      ceoDeploymentId: ceo.id,
    });
    await bumpThreadResetGeneration(threadId);
  }

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
    case "adapter_failed": {
      // Adapter-failed surfaces as a system message (already inserted)
      // rather than an HTTP error — the FE renders it inline so the user
      // sees what happened without a toast.
      log.warn(
        { companyId },
        "CEO adapter call failed; system message returned to UI",
      );
      const [user, assistant] = await serializeMessages([
        result.user,
        result.assistant,
      ]);
      res.status(StatusCodes.CREATED).json({
        user,
        assistant,
        createdTask: null,
      } satisfies SendChatMessageResponse);
      return;
    }
    case "ok": {
      const [user, assistant] = await serializeMessages([
        result.user,
        result.assistant,
      ]);
      res.status(StatusCodes.CREATED).json({
        user,
        assistant,
        createdTask: result.createdTask,
      } satisfies SendChatMessageResponse);
      return;
    }
  }
});

// ── Per-agent direct chat (user ↔ owned agent) ──────────────────────────
//
// Mirror of the /ceo trio, but the target is an arbitrary agent the
// caller OWNS (agent identity ownerUserId === user). Ownership is the gate
// the multi-user model needs: a company operator can NOT chat agents owned
// by another user (marketplace hires), only their own. Marker-driven OS
// actions are disabled server-side for this surface (see chat-handler).

// Resolve the target deployment for a per-agent chat route, enforcing both
// company scope and identity ownership. Writes the 404/NO_COMPANY response
// and returns null when the caller may not chat this agent.
async function resolveOwnedChatTarget(
  req: Request,
  res: Response,
): Promise<{ companyId: string; deploymentId: string } | null> {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return null;
  }
  const owned = await findOwnedByUserId({
    userId: req.user!.userId,
    deploymentId: req.params.deploymentId,
  });
  // Must be owned AND deployed to the caller's company — keeps thread /
  // message scoping (companyId, deploymentId) consistent and blocks
  // chatting an owned agent that's working at a different company.
  if (!owned || owned.companyId !== companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return null;
  }
  return { companyId, deploymentId: owned.id };
}

router.get(
  "/agent/:deploymentId",
  requireAuth,
  async (req: Request, res: Response) => {
    const target = await resolveOwnedChatTarget(req, res);
    if (!target) return;
    const generation =
      parseGenerationQuery(req.query.generation) ??
      (await getThreadResetGeneration({
        companyId: target.companyId,
        deploymentId: target.deploymentId,
        kind: "user_agent",
      }));
    const rows = await listMessages({
      companyId: target.companyId,
      deploymentId: target.deploymentId,
      generation,
    });
    const out: ListChatMessagesResponse = {
      messages: await serializeMessages(rows),
    };
    res.json(out);
  },
);

// GET /agent/:deploymentId/sessions — History list for a per-agent chat.
router.get(
  "/agent/:deploymentId/sessions",
  requireAuth,
  async (req: Request, res: Response) => {
    const target = await resolveOwnedChatTarget(req, res);
    if (!target) return;
    const [sessions, currentGeneration] = await Promise.all([
      listSessions({ companyId: target.companyId, deploymentId: target.deploymentId }),
      getThreadResetGeneration({
        companyId: target.companyId,
        deploymentId: target.deploymentId,
        kind: "user_agent",
      }),
    ]);
    res.json({ sessions, currentGeneration });
  },
);

router.delete(
  "/agent/:deploymentId",
  requireAuth,
  async (req: Request, res: Response) => {
    const target = await resolveOwnedChatTarget(req, res);
    if (!target) return;

    // Same two-step reset as /ceo: drop the gateway session (best-effort)
    // then bump reset_generation so the next turn derives a fresh key.
    const profile = await findRuntimeProfile(target.deploymentId);
    if (profile?.externalAgentId) {
      try {
        const { id: threadId, resetGeneration } =
          await resolveUserAgentThreadId({
            companyId: target.companyId,
            deploymentId: target.deploymentId,
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
              { deploymentId: target.deploymentId, error: result.error },
              "resetSession failed on agent thread clear (non-fatal)",
            );
          }
        }
        await bumpThreadResetGeneration(threadId);
      } catch (err) {
        req.log.warn(
          { err, deploymentId: target.deploymentId },
          "agent thread reset cleanup failed (non-fatal)",
        );
      }
    } else {
      const { id: threadId } = await resolveUserAgentThreadId({
        companyId: target.companyId,
        deploymentId: target.deploymentId,
      });
      await bumpThreadResetGeneration(threadId);
    }

    res.status(StatusCodes.NO_CONTENT).end();
  },
);

router.post(
  "/agent/:deploymentId",
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = sendChatMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.INVALID_BODY,
        detail: parsed.error.flatten(),
      });
      return;
    }
    const target = await resolveOwnedChatTarget(req, res);
    if (!target) return;

    const result = await sendUserTurn({
      companyId: target.companyId,
      userId: req.user!.userId,
      content: parsed.data.content,
      targetDeploymentId: target.deploymentId,
    });

    switch (result.kind) {
      case "no_ceo":
        // Target vanished between ownership check and dispatch.
        res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
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
      case "adapter_failed": {
        const [user, assistant] = await serializeMessages([
          result.user,
          result.assistant,
        ]);
        res.status(StatusCodes.CREATED).json({
          user,
          assistant,
          createdTask: null,
        } satisfies SendChatMessageResponse);
        return;
      }
      case "ok": {
        const [user, assistant] = await serializeMessages([
          result.user,
          result.assistant,
        ]);
        res.status(StatusCodes.CREATED).json({
          user,
          assistant,
          createdTask: result.createdTask,
        } satisfies SendChatMessageResponse);
        return;
      }
    }
  },
);

export default router;
