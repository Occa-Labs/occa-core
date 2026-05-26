import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import jwt from "jsonwebtoken";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { companies, traceEvents, traces } from "@occa/shared/schema";
import type {
  AuthTokenPayload,
  ListTraceEventsResponse,
  TraceResponse,
} from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import { requireAuth } from "../../../middleware/auth";
import { subscribeToTrace } from "../../../services/trace-events-bus";
import { toEventDTO, toTraceDTO } from "../domain/dto";
import { cancelBody, eventsQuery } from "../domain/schemas";

// Grace period before closing a completed SSE connection — gives browsers a
// beat to receive the final event before the socket drops.
const SSE_CLOSE_GRACE_MS = 100;
// Idle keepalive ping interval. Lower than nginx's 60s default.
const SSE_HEARTBEAT_MS = 25_000;

const router: Router = Router();

async function userCompanyId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(
        eq(companies.ownerUserId, userId),
        eq(companies.kind, "user"),
        isNull(companies.deletedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function loadTraceForUser(
  userId: string,
  traceId: string,
): Promise<typeof traces.$inferSelect | null> {
  const companyId = await userCompanyId(userId);
  if (!companyId) return null;
  const [row] = await db
    .select()
    .from(traces)
    .where(
      and(eq(traces.id, traceId), eq(traces.companyId, companyId)),
    )
    .limit(1);
  return row ?? null;
}

// GET /api/traces/:id
router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const trace = await loadTraceForUser(req.user!.userId, req.params.id);
  if (!trace) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TRACE_NOT_FOUND });
    return;
  }
  const body: TraceResponse = { trace: toTraceDTO(trace) };
  res.json(body);
});

// GET /api/traces/:id/events?afterSeq=N
router.get(
  "/:id/events",
  requireAuth,
  async (req: Request, res: Response) => {
    const trace = await loadTraceForUser(req.user!.userId, req.params.id);
    if (!trace) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TRACE_NOT_FOUND });
      return;
    }
    const q = eventsQuery.safeParse(req.query);
    if (!q.success) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_QUERY });
      return;
    }
    const afterSeq = q.data.afterSeq ?? 0;
    const limit = q.data.limit ?? 200;
    const rows = await db
      .select()
      .from(traceEvents)
      .where(
        and(
          eq(traceEvents.traceId, trace.id),
          gt(traceEvents.seq, afterSeq),
        ),
      )
      .orderBy(asc(traceEvents.seq))
      .limit(limit);
    const events = rows.map(toEventDTO);
    const nextSeq = events.length ? events[events.length - 1].seq : afterSeq;
    const body: ListTraceEventsResponse = { events, nextSeq };
    res.json(body);
  },
);

// POST /api/traces/:id/cancel — user marks a trace for cancellation. Worker
// picks this up on the next dispatcher tick and stops the in-flight executor.
router.post(
  "/:id/cancel",
  requireAuth,
  async (req: Request, res: Response) => {
    const trace = await loadTraceForUser(req.user!.userId, req.params.id);
    if (!trace) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TRACE_NOT_FOUND });
      return;
    }
    const parsed = cancelBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    if (trace.status !== "queued" && trace.status !== "running") {
      res
        .status(StatusCodes.CONFLICT)
        .json({ error: ERROR_CODES.TRACE_NOT_CANCELLABLE, status: trace.status });
      return;
    }
    const reason = parsed.data.reason ?? "cancelled_by_user";
    const [updated] = await db
      .update(traces)
      .set({
        status: "cancelled",
        finishedAt: new Date(),
        updatedAt: new Date(),
        error: reason,
        errorCode: "cancelled",
      })
      .where(eq(traces.id, trace.id))
      .returning();
    const body: TraceResponse = { trace: toTraceDTO(updated) };
    res.json(body);
  },
);

// GET /api/traces/:id/stream
// SSE endpoint. Streams trace events + lifecycle transitions live.
// Auth: token via `?token=` query param (EventSource can't send headers) or
// Authorization header. Closes connection on trace finish or client disconnect.
router.get("/:id/stream", async (req: Request, res: Response) => {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).end();
    return;
  }

  const headerToken = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice("Bearer ".length)
    : null;
  const queryToken =
    typeof req.query.token === "string" ? req.query.token : null;
  const token = headerToken ?? queryToken;
  if (!token) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: ERROR_CODES.MISSING_TOKEN });
    return;
  }

  let userId: string;
  try {
    const payload = jwt.verify(token, jwtSecret) as AuthTokenPayload;
    userId = payload.userId;
  } catch {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: ERROR_CODES.INVALID_TOKEN });
    return;
  }

  const trace = await loadTraceForUser(userId, req.params.id);
  if (!trace) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TRACE_NOT_FOUND });
    return;
  }

  // SSE headers.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx proxy buffering
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Initial snapshot so the client doesn't need a separate fetch on open.
  send("snapshot", { trace: toTraceDTO(trace) });

  // If the trace is already finished, close immediately — nothing to stream.
  if (trace.status !== "running" && trace.status !== "queued") {
    send("close", { reason: "already_finished", status: trace.status });
    res.end();
    return;
  }

  const unsubscribe = subscribeToTrace(trace.id, (event) => {
    if (event.eventType === "lifecycle") {
      send("lifecycle", event);
      if (event.phase === "completed" || event.phase === "failed") {
        // Give the client a beat to receive the final event before the
        // connection drops — fast-closing browsers sometimes miss it.
        setTimeout(() => {
          res.end();
        }, SSE_CLOSE_GRACE_MS);
      }
    } else {
      send("stream", event);
    }
  });

  // Heartbeat keeps proxies/load balancers from timing out idle
  // connections (nginx default is 60s).
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, SSE_HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

export default router;
