import pinoHttp from "pino-http";
import { logger } from "../lib/logger";

// HTTP access-log middleware. Auto-logs every request/response/error with a
// reqId for correlation. Routes can use `req.log` for any in-handler logging
// to inherit the same reqId binding.

// High-frequency polling endpoints whose 200/304 responses dominate the log
// without diagnostic value. We silence the success path and still surface
// errors (4xx/5xx) via customLogLevel below. Match against the URL pathname
// (query strings stripped) so all variants of e.g.
// `/api/approvals?status=pending` collapse to the same rule.
const POLLING_PATHS = new Set<string>([
  "/api/approvals",
  "/api/me",
  "/api/auth/me",
  "/api/skills",
]);

// Per-agent polling endpoints that share a UUID segment. Using a regex
// keeps us decoupled from individual agent IDs while still catching the
// hot-path skill-syncs / activity / traces / files pollers that dominate
// dev.log when the Agents window is open.
const AGENT_POLLING_SUFFIXES = /\/api\/agents\/[0-9a-f-]{36}\/(skills\/syncs|activity|traces|files)$/;

function isPollingPath(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split("?", 1)[0];
  return POLLING_PATHS.has(path) || AGENT_POLLING_SUFFIXES.test(path);
}

export const httpLogger = pinoHttp({
  logger,
  // Skip the /health probe — it'd dominate the log otherwise.
  autoLogging: {
    ignore: (req) => req.url === "/health",
  },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    // Silence successful poll responses — they're a constant 3-10s drum
    // beat from the dashboard and the notification badge that drowns
    // out everything else. Errors still hit error/warn above.
    if (isPollingPath(req.url) && res.statusCode < 400) return "silent";
    return "info";
  },
  // Keep req/res shape lean — full headers add noise, redact-able later.
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
});
