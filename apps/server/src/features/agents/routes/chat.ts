// POST /api/agents/:id/chat — send a message directly to the agent via
// the OpenClaw gateway WebSocket and return the streamed reply. Bypasses
// the wake/trace dispatch — gateway proxies the message straight to the
// runtime. A fresh trace row records the conversation turn.

import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import {
  chatWithAgent,
  deserializeKeypair,
  type SerializedKeypair,
} from "@occa/adapter-openclaw";
import { traces, traceEvents } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { findOwnedByUserId } from "../repositories/agents";
import { requireAuth } from "../../../middleware/auth";
import { agentChatBody } from "../domain/schemas";
import { AGENT_WAIT_TIMEOUT_MS, TRACE_EVENT_FLUSH_MS } from "../../../lib/timing";
import { log } from "./_shared";

const router: Router = Router();

router.post("/:id/chat", requireAuth, async (req: Request, res: Response) => {
  const existing = await findOwnedByUserId({
    userId: req.user!.userId,
    agentId: req.params.id,
  });
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }

  const parsed = agentChatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_BODY,
      detail: parsed.error.flatten(),
    });
    return;
  }

  const cfg = (existing.adapterConfig ?? {}) as Record<string, unknown>;
  if (
    typeof cfg.gatewayUrl !== "string" ||
    typeof cfg.apiKey !== "string" ||
    !cfg.deviceKeypair
  ) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.AGENT_NOT_CONFIGURED });
    return;
  }

  if (!existing.externalAgentId) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.AGENT_NOT_PROVISIONED });
    return;
  }

  const device = deserializeKeypair(cfg.deviceKeypair as SerializedKeypair);
  const openclawAgentId =
    typeof cfg.openclawAgentId === "string"
      ? cfg.openclawAgentId
      : existing.externalAgentId;

  // Create a trace row to record this chat turn.
  const now = new Date();
  const [traceRow] = await db
    .insert(traces)
    .values({
      companyId: existing.companyId,
      agentId: existing.id,
      invocationSource: "chat",
      conversationId: parsed.data.conversationId,
      actorType: "user",
      actorId: req.user!.userId,
      status: "running",
      startedAt: now,
    })
    .returning({ id: traces.id });
  const traceId = traceRow.id;

  // Stream gateway events back to browser via SSE.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  const writeSSE = (eventName: string | null, data: unknown) => {
    if (closed) return;
    if (eventName) res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Persist gateway events to trace_events; seq is monotonically incremented.
  let seq = 0;
  const pendingEvents: Array<typeof traceEvents.$inferInsert> = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushEvents = async () => {
    flushTimer = null;
    if (pendingEvents.length === 0) return;
    const toInsert = pendingEvents.splice(0);
    try {
      await db.insert(traceEvents).values(toInsert);
    } catch (err) {
      log.warn({ err }, "trace event flush failed");
    }
  };

  const queueEvent = (stream: string, payload: Record<string, unknown>) => {
    pendingEvents.push({
      companyId: existing.companyId,
      traceId,
      agentId: existing.id,
      seq: seq++,
      eventType: "stream",
      stream,
      payload,
    });
    if (!flushTimer)
      flushTimer = setTimeout(() => void flushEvents(), TRACE_EVENT_FLUSH_MS);
  };

  const result = await chatWithAgent(
    {
      gatewayUrl: cfg.gatewayUrl as string,
      apiKey: cfg.apiKey as string,
      device,
      openclawAgentId,
      message: parsed.data.message,
      conversationId: parsed.data.conversationId,
      onEvent: (evt) => {
        writeSSE(null, evt);
        queueEvent(evt.stream, evt.data);
      },
    },
    { waitTimeoutMs: AGENT_WAIT_TIMEOUT_MS },
  );

  // Flush any remaining events before updating trace status.
  if (flushTimer) clearTimeout(flushTimer);
  await flushEvents();

  const finishedAt = new Date();
  if (!result.ok) {
    await db
      .update(traces)
      .set({
        status: "failed",
        finishedAt,
        error: result.reason ?? result.error,
        errorCode: result.error,
        updatedAt: finishedAt,
      })
      .where(eq(traces.id, traceId));
    writeSSE("error", { error: result.error, reason: result.reason });
  } else {
    await db
      .update(traces)
      .set({
        status: "succeeded",
        finishedAt,
        resultJson: { text: result.reply },
        updatedAt: finishedAt,
      })
      .where(eq(traces.id, traceId));
    writeSSE("done", { reply: result.reply });
  }
  res.end();
});

export default router;
