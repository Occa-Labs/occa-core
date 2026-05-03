import path from "node:path";
import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

// Optional file destination for dev runs — lets external tooling (and
// Claude Code sessions debugging the running server) tail logs without
// scraping the terminal that owns the process.
//
//   OCCA_LOG_FILE=/abs/path  → write structured NDJSON there
//   OCCA_LOG_FILE=off        → disable the file sink even in dev
//   (unset)                  → defaults to apps/server/dev.log in dev,
//                              disabled in prod (orchestrator captures stdout)
function resolveLogFile(): string | null {
  const env = process.env.OCCA_LOG_FILE;
  if (env === "off") return null;
  if (env && env.length > 0) return env;
  if (!isDev) return null;
  // From apps/server/src/lib → apps/server/ (3 levels up).
  return path.resolve(__dirname, "../../dev.log");
}

const logFile = resolveLogFile();

const targets: pino.TransportTargetOptions[] = [
  {
    target: "pino-pretty",
    level: "debug",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname",
    },
  },
];

if (logFile) {
  targets.push({
    // Raw NDJSON destination. Capture trace+ here so missed signals can
    // be recovered later even if the console level was bumped up. The
    // file is a dev artifact; size isn't a concern, but if it ever
    // grows out of hand, truncate it manually — there's no log rotation.
    target: "pino/file",
    level: "trace",
    options: { destination: logFile, mkdir: true, append: true },
  });
}

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
    ...(isDev
      ? {}
      : {
          // In production keep pure JSON — pipe through pino-pretty externally
          // if human-readable output is needed (e.g. `node src/index.js | pino-pretty`).
        }),
  },
  isDev ? pino.transport({ targets }) : undefined,
);

/**
 * Returns a child logger pre-tagged with a module name.
 * Usage: `const log = childLogger("agent-create")`
 *        `log.info("step 3 done")`
 */
export function childLogger(module: string) {
  return logger.child({ module });
}
