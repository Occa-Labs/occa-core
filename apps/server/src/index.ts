import express from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import cors from "cors";
import { createServer } from "http";
import { childLogger } from "./lib/logger";
import { httpLogger } from "./middleware/http-logger";

const log = childLogger("server");
import { ensureSchema } from "./infra/database/ensure-schema";
import { backfillDeploymentSeats } from "./features/agents/services/seat-backfill";
import { seedOccaDefaultSkills } from "./features/skills/services/seed-occa-defaults";
import { enqueuePendingTasks, reapOrphans } from "./features/tasks/services/orphan-reaper";
import { getBoss, stopBoss } from "./infra/queue/boss";
import { registerTaskWorker } from "./infra/queue/task-worker";
import { registerWorkflowWorker } from "./infra/queue/workflow-worker";
import { registerAgentDmWorker } from "./infra/queue/agent-dm-worker";
import { registerReviewWorker } from "./infra/queue/review-worker";
import {
  startWorkflowTriggerPoller,
  stopWorkflowTriggerPoller,
} from "./features/workflows/services/workflow-trigger-poller";
import {
  startDailyAnchorCron,
  stopDailyAnchorCron,
} from "./features/chain/services/daily-anchor-cron";
import {
  startTreasuryReadinessCron,
  stopTreasuryReadinessCron,
} from "./features/billing/services/treasury-readiness-cron";
import {
  startIdempotencyCleanup,
  stopIdempotencyCleanup,
} from "./services/idempotency-cleanup";
import authRouter from "./features/auth/routes";
import userMeRouter from "./features/auth/routes/me";
import agentMeSelfRouter from "./features/agents/routes/agent-me";
import agentMeSkillsRouter from "./features/skills/routes/agent-me";
import agentMeToolsRouter from "./features/tools/routes/agent-me";
import agentMeDocumentsRouter from "./features/documents/routes/agent-me";
import adaptersRouter from "./features/adapters/routes";
import {
  tasksFeatureRouter,
  agentTaskCommentsRouter,
} from "./features/tasks/routes";
import skillsRouter from "./features/skills/routes";
import agentsRouter from "./features/agents/routes";
import companiesRouter from "./features/companies/routes";
import chainRouter from "./features/chain/routes";
import publicChainRouter from "./features/chain/routes/public";
import tracesRouter from "./features/traces/routes";
import routinesRouter from "./features/routines/routes";
import approvalsRouter from "./features/approvals/routes";
import notificationsRouter from "./features/notifications/routes";
import workflowsRouter from "./features/workflows/routes";
import chatRouter from "./features/chat/routes";
import companyBrainRouter from "./features/company-brain/routes";
import documentsRouter from "./features/documents/routes";
import {
  catalogRouter as toolCatalogRouter,
  companyToolsRouter,
  invokeRouter as toolInvokeRouter,
} from "./features/tools/routes";
import devRouter from "./routes/dev";
import { mcpRouter } from "./features/mcp-server/routes/mcp-http";

const port = parseInt(process.env.PORT || "3002", 10);
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:3001";

const app = express();
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());
app.use(httpLogger);

app.use("/api/auth", authRouter);
app.use("/api/me", userMeRouter);
// /api/me/agent/* — agent-token authenticated, sub-routes per feature.
// Specific sub-paths registered before the bare `/me/agent` mount so
// Express tries them first (otherwise a future `:id` on the self-router
// would shadow `/skills`, `/tools`, `/documents`).
app.use("/api/me/agent/skills", agentMeSkillsRouter);
app.use("/api/me/agent/tools", agentMeToolsRouter);
app.use("/api/me/agent/documents", agentMeDocumentsRouter);
app.use("/api/me/agent", agentMeSelfRouter);
app.use("/api/adapters", adaptersRouter);
app.use("/api/tasks", tasksFeatureRouter);
app.use("/api/skills", skillsRouter);
app.use("/api/agents", agentTaskCommentsRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/companies", companiesRouter);
app.use("/api/chain", chainRouter);
// Public, read-only, no-auth surface for scan.occaai.com — wide-open
// CORS since these endpoints carry no secrets.
app.use("/api/public", cors({ origin: "*" }), publicChainRouter);
app.use("/api/traces", tracesRouter);
app.use("/api/routines", routinesRouter);
app.use("/api/approvals", approvalsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/workflows", workflowsRouter);
app.use("/api/chat", chatRouter);
app.use("/api/company-brain", companyBrainRouter);
app.use("/api/documents", documentsRouter);
app.use("/api/tool-catalog", toolCatalogRouter);
app.use("/api/companies/:companyId/tools", companyToolsRouter);
app.use("/api/tools", toolInvokeRouter);
app.use("/api/dev", devRouter);

// OCCA-as-MCP-server surface, mounted outside /api on purpose: Streamable
// HTTP transport for MCP clients (Hermes Agent today). Auth is a Bearer
// token, not the OS-session cookie used by the /api surface.
app.use("/mcp", mcpRouter);

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

  // Self-heal any runtime-profile rows from before the seat-assignment
  // migration (workstation_id NULL). Idempotent no-op once every
  // deployment has a desk.
  await backfillDeploymentSeats();

  // Reset anything left "running" by a prior crash/restart BEFORE the worker
  // comes online — otherwise those traces sit in "running" forever.
  await reapOrphans();

  // Start pg-boss and bind the task.dispatch worker. Worker runs in-process
  // for now; easy to split into a separate apps/worker later.
  await getBoss();
  await registerTaskWorker();
  await registerWorkflowWorker();
  await registerAgentDmWorker();
  await registerReviewWorker();
  // Polls task_events for done transitions and enqueues workflow.evaluate
  // jobs. Single hook point covers both server- and worker-finalised tasks.
  startWorkflowTriggerPoller();
  // Daily cleanup of old agent_action_idempotency rows. Best-effort.
  startIdempotencyCleanup();
  // Daily Merkle anchor commit per (deployment, UTC day). Hourly tick
  // checks for unanchored prior-day work + submits via the operator key.
  startDailyAnchorCron();
  // Hourly scan for companies with pending payable invoices → emit a
  // `treasury_readiness` notification (dedupe-aware, at most one per
  // company per 24h). Operator still clicks Run Payroll — this is just
  // the signal. See [[project_phase1_treasury_design]] decision #7.
  startTreasuryReadinessCron();

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
    stopWorkflowTriggerPoller();
    stopIdempotencyCleanup();
    stopDailyAnchorCron();
    stopTreasuryReadinessCron();
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
