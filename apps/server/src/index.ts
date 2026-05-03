import express from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import cors from "cors";
import { createServer } from "http";
import { childLogger } from "./lib/logger";
import { httpLogger } from "./middleware/http-logger";

const log = childLogger("server");
import { ensureSchema } from "./infra/database/ensure-schema";
import { backfillAgentSeats } from "./features/agents/services/seat-backfill";
import { seedOccaDefaultSkills } from "./features/skills/services/seed-occa-defaults";
import { enqueuePendingTasks, reapOrphans } from "./services/orphan-reaper";
import { getBoss, stopBoss } from "./infra/queue/boss";
import { registerTaskWorker } from "./infra/queue/task-worker";
import authRouter from "./features/auth/routes";
import meRouter from "./routes/me";
import adaptersRouter from "./routes/adapters";
import tasksRouter from "./routes/tasks";
import skillsRouter from "./features/skills/routes";
import agentsRouter from "./features/agents/routes";
import companiesRouter from "./features/companies/routes";
import tracesRouter from "./routes/traces";
import routinesRouter from "./routes/routines";
import approvalsRouter from "./routes/approvals";
import devRouter from "./routes/dev";

const port = parseInt(process.env.PORT || "3002", 10);
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:3001";

const app = express();
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());
app.use(httpLogger);

app.use("/api/auth", authRouter);
app.use("/api/me", meRouter);
app.use("/api/adapters", adaptersRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/skills", skillsRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/companies", companiesRouter);
app.use("/api/traces", tracesRouter);
app.use("/api/routines", routinesRouter);
app.use("/api/approvals", approvalsRouter);
app.use("/api/dev", devRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.use("/api", (_req, res) => {
  res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
});

// Global error handler. Uses req.log (provided by pino-http) so the entry
// is auto-correlated with the request's reqId. pino-http itself will also
// log the request/response lifecycle around it.
app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    req.log.error({ err }, "unhandled route error");
    res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json({ error: ERROR_CODES.INTERNAL_ERROR });
  },
);

async function main() {
  await ensureSchema();

  // Self-heal any agent rows from before the seat-assignment migration
  // (workstation_id NULL). Idempotent no-op once every agent has a desk.
  await backfillAgentSeats();

  // Reset anything left "running" by a prior crash/restart BEFORE the worker
  // comes online — otherwise those traces sit in "running" forever.
  await reapOrphans();

  // Start pg-boss and bind the task.dispatch worker. Worker runs in-process
  // for now; easy to split into a separate apps/worker later.
  await getBoss();
  await registerTaskWorker();

  // Auto-enqueue any task with an assigned agent that never got dispatched
  // (created before pg-boss existed, or reverted by the reaper above).
  await enqueuePendingTasks();

  // Fire-and-forget: seed failures must not block the server from accepting
  // requests. Next boot retries any entry that didn't land.
  seedOccaDefaultSkills().catch((err) => {
    log.error({ err }, "seed OCCA default skills failed");
  });

  const server = createServer(app);
  server.listen(port, () => {
    log.info({ port }, "server ready");
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutdown signal received");
    server.close();
    try {
      await stopBoss();
    } catch (err) {
      log.error({ err }, "error stopping pg-boss");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.error({ err }, "server boot failed");
  process.exit(1);
});
