// @occa/claude-gateway — a thin HTTP service that wraps `claude -p` so OCCA
// can run Claude Code agents on a remote box it does not own (BYORT). The
// box owner installs claude, runs `claude login`, and starts this gateway
// with a shared bearer. OCCA's claude-code adapter (remote mode) talks to it
// over HTTP, exactly like the hermes adapter talks to a Hermes gateway.
//
// Endpoints (all require `Authorization: Bearer <CLAUDE_GATEWAY_TOKEN>`):
//   GET  /v1/health       — probe claude + auth, returns {ok,...}
//   POST /v1/seed         — write workspace files for an agent
//   POST /v1/run          — run one turn, stream NDJSON events + a result line
//   POST /v1/deprovision  — remove an agent's workspace
//
// The gateway is OCCA-agnostic: it knows nothing about deployments, tasks,
// or markers. It writes the files it's handed and runs the prompt it's given.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  runClaude,
  probeClaude,
  sessionUuidFromKey,
  type ClaudeStreamEvent,
} from "../claude-cli";
import { workspacePathFor } from "../workspace";
import { loadConfig } from "./config";

const config = loadConfig();

function log(level: "info" | "warn" | "error", obj: Record<string, unknown>, msg: string): void {
  const line = JSON.stringify({ level, msg, ...obj });
  if (level === "error") console.error(line);
  else console.log(line);
}

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  const prefix = "Bearer ";
  return header.startsWith(prefix) && header.slice(prefix.length) === config.token;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function readJsonBody(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          resolve(parsed as Record<string, unknown>);
        } else {
          reject(new Error("body_not_object"));
        }
      } catch {
        reject(new Error("body_invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === "string");
}

// ── Handlers ──────────────────────────────────────────────────────────────

async function handleHealth(res: ServerResponse): Promise<void> {
  const probe = await probeClaude(config.healthModel);
  sendJson(res, 200, {
    object: "claude.gateway.health",
    ok: probe.ok,
    error: probe.ok ? undefined : probe.error,
    reason: probe.ok ? undefined : probe.reason,
  });
}

async function handleSeed(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, config.maxBodyBytes);
  const externalAgentId = asString(body.externalAgentId);
  if (!externalAgentId) {
    sendJson(res, 400, { ok: false, error: "externalAgentId required" });
    return;
  }
  const files = Array.isArray(body.files) ? body.files : [];
  const workspacePath = workspacePathFor(externalAgentId);
  await mkdir(workspacePath, { recursive: true });
  let pushed = 0;
  for (const raw of files) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    const filename = asString(f.filename);
    const content = typeof f.content === "string" ? f.content : null;
    if (!filename || content === null) continue;
    // Guard against path traversal — files land flat in the workspace.
    if (filename.includes("/") || filename.includes("..")) continue;
    await writeFile(join(workspacePath, filename), content, "utf8");
    pushed += 1;
  }
  sendJson(res, 200, { ok: true, pushed });
}

async function handleDeprovision(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, config.maxBodyBytes);
  const externalAgentId = asString(body.externalAgentId);
  if (!externalAgentId) {
    sendJson(res, 400, { ok: false, error: "externalAgentId required" });
    return;
  }
  await rm(workspacePathFor(externalAgentId), { recursive: true, force: true }).catch(() => {});
  sendJson(res, 200, { ok: true });
}

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, config.maxBodyBytes);
  const externalAgentId = asString(body.externalAgentId);
  const prompt = typeof body.prompt === "string" ? body.prompt : null;
  const model = asString(body.model);
  const sessionKey = asString(body.sessionKey);
  if (!externalAgentId || prompt === null || !model || !sessionKey) {
    sendJson(res, 400, {
      ok: false,
      error: "externalAgentId, prompt, model and sessionKey are required",
    });
    return;
  }

  // Stream NDJSON: one `{t:"event",...}` line per run event, a final
  // `{t:"result",...}` line carrying the reply + usage.
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });

  const controller = new AbortController();
  let finished = false;
  // Client disconnect mid-run → cancel the underlying claude process.
  res.on("close", () => {
    if (!finished) controller.abort();
  });

  const onEvent = (event: ClaudeStreamEvent): void => {
    res.write(`${JSON.stringify({ t: "event", event })}\n`);
  };

  const result = await runClaude({
    prompt,
    cwd: workspacePathFor(externalAgentId),
    model,
    sessionUuid: sessionUuidFromKey(sessionKey),
    appendSystemPrompt: asString(body.appendSystemPrompt),
    allowedTools: asStringArray(body.allowedTools),
    disallowedTools: asStringArray(body.disallowedTools),
    timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
    signal: controller.signal,
    onEvent,
  });

  finished = true;
  res.write(`${JSON.stringify({ t: "result", result })}\n`);
  res.end();
}

// ── Router ──────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const method = req.method ?? "GET";
  const url = (req.url ?? "").split("?")[0];

  if (!authed(req)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }

  const route = `${method} ${url}`;
  const handler =
    route === "GET /v1/health"
      ? () => handleHealth(res)
      : route === "POST /v1/seed"
        ? () => handleSeed(req, res)
        : route === "POST /v1/run"
          ? () => handleRun(req, res)
          : route === "POST /v1/deprovision"
            ? () => handleDeprovision(req, res)
            : null;

  if (!handler) {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return;
  }

  handler().catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    log("error", { route, reason }, "gateway handler failed");
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: "internal_error", reason });
    } else {
      // Mid-stream failure — close the NDJSON response cleanly.
      try {
        res.write(`${JSON.stringify({ t: "result", result: { ok: false, error: "internal_error", reason } })}\n`);
      } catch {
        /* ignore */
      }
      res.end();
    }
  });
});

server.listen(config.port, config.host, () => {
  log("info", { host: config.host, port: config.port }, "claude-gateway listening");
});
