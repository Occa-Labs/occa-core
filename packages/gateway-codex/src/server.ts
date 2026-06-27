// @occa/gateway-codex — a thin HTTP service that wraps `codex exec` so OCCA can
// run Codex agents on a remote box it does not own (BYORT). The box owner
// installs codex, authenticates it (OPENAI_API_KEY or `codex login`), and
// starts this gateway with a shared bearer. OCCA's codex adapter talks to it
// over HTTP, exactly like the claude-code adapter talks to a Claude Gateway.
//
// Endpoints (all require `Authorization: Bearer <CODEX_GATEWAY_TOKEN>`):
//   GET  /v1/health       — probe codex binary, returns {ok,...}
//   POST /v1/seed         — write workspace files (AGENTS.md + persona) for an agent
//   POST /v1/run          — run one turn, stream NDJSON events + a result line
//   POST /v1/cancel       — abort an in-flight run by sessionKey
//   POST /v1/deprovision  — remove an agent's workspace
//
// The gateway is OCCA-agnostic: it writes the files it's handed and runs the
// prompt it's given. It knows nothing about deployments, tasks, or markers.

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  runCodex,
  codexAvailable,
  type CodexStreamEvent,
  type RunCodexResult,
} from "./codex-cli";
import { workspacePathFor } from "./workspace";
import type { GatewayConfig } from "./config";

let config: GatewayConfig;

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
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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
  // Cheap liveness only (codex binary present + this request proves the gateway
  // is up and the bearer is valid). No real `codex exec` — the connection probe
  // hits this every ~90s per agent.
  const probe = await codexAvailable();
  sendJson(res, 200, {
    object: "codex.gateway.health",
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

// ── Run registry ──────────────────────────────────────────────────────────
//
// A run is DECOUPLED from the HTTP connection that started it. Stream events
// and the final result are buffered per `sessionKey`, so a client whose
// connection drops mid-run can RE-POST /v1/run with the same sessionKey and
// resume from where it left off — the underlying `codex exec` keeps running.
interface RunRecord {
  events: CodexStreamEvent[];
  result: RunCodexResult | null;
  done: boolean;
  controller: AbortController;
  subscribers: Set<ServerResponse>;
  evictTimer: ReturnType<typeof setTimeout> | null;
  // Resolves when the underlying `codex` process has exited. A superseding turn
  // on the same sessionKey awaits this before resuming, so two processes never
  // touch the same thread at once.
  finished: Promise<void>;
  finish: () => void;
}

const runs = new Map<string, RunRecord>();

const COMPLETED_TTL_MS = 60_000;

function writeLine(res: ServerResponse, obj: unknown): void {
  try {
    res.write(`${JSON.stringify(obj)}\n`);
  } catch {
    /* dead socket — harmless */
  }
}

function attachSubscriber(record: RunRecord, res: ServerResponse, fromIndex: number): void {
  for (let i = Math.max(0, fromIndex); i < record.events.length; i++) {
    writeLine(res, { t: "event", event: record.events[i] });
  }
  if (record.done) {
    writeLine(res, { t: "result", result: record.result });
    try {
      res.end();
    } catch {
      /* ignore */
    }
    return;
  }
  record.subscribers.add(res);
  res.on("close", () => {
    record.subscribers.delete(res);
  });
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

  res.writeHead(200, { "Content-Type": "application/x-ndjson" });

  // A reconnect carries resumeCursor; a fresh dispatch does not. A reconnect
  // ATTACHES to the existing run; a fresh dispatch on a sessionKey that still
  // has a record is a NEW turn and must start its own run.
  const isReconnect = typeof body.resumeCursor === "number";
  const resumeCursor = isReconnect ? (body.resumeCursor as number) : 0;

  const existing = runs.get(sessionKey);
  if (existing && isReconnect) {
    attachSubscriber(existing, res, resumeCursor);
    return;
  }
  if (existing) {
    if (!existing.done) {
      existing.controller.abort();
      await existing.finished.catch(() => {});
    }
    if (existing.evictTimer) clearTimeout(existing.evictTimer);
    runs.delete(sessionKey);
  }

  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const record: RunRecord = {
    events: [],
    result: null,
    done: false,
    controller: new AbortController(),
    subscribers: new Set(),
    evictTimer: null,
    finished,
    finish,
  };
  runs.set(sessionKey, record);
  attachSubscriber(record, res, 0);

  const started = Date.now();
  log("info", { externalAgentId, model, sessionKey, promptChars: prompt.length }, "run start");

  // We do NOT abort on client disconnect — the run is bounded by `timeoutMs`
  // (server-side wall clock), and a reconnecting client can resume it.
  // Cancellation is explicit via POST /v1/cancel.
  const result = await runCodex({
    prompt,
    cwd: workspacePathFor(externalAgentId),
    model,
    // Codex has no settable session id — pass the raw sessionKey; runCodex maps
    // it to a captured thread_id for resume.
    sessionKey,
    appendSystemPrompt: asString(body.appendSystemPrompt),
    allowedTools: asStringArray(body.allowedTools),
    disallowedTools: asStringArray(body.disallowedTools),
    timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
    // maxBudgetUsd is intentionally ignored — codex has no per-run cost cap.
    signal: record.controller.signal,
    onEvent: (event: CodexStreamEvent) => {
      record.events.push(event);
      for (const sub of record.subscribers) writeLine(sub, { t: "event", event });
    },
  });

  record.result = result;
  record.done = true;
  log("info", { externalAgentId, sessionKey, durationMs: Date.now() - started }, "run done");
  for (const sub of record.subscribers) {
    writeLine(sub, { t: "result", result });
    try {
      sub.end();
    } catch {
      /* ignore */
    }
  }
  record.subscribers.clear();
  record.finish();
  record.evictTimer = setTimeout(() => runs.delete(sessionKey), COMPLETED_TTL_MS);
}

async function handleCancel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, config.maxBodyBytes);
  const sessionKey = asString(body.sessionKey);
  if (!sessionKey) {
    sendJson(res, 400, { ok: false, error: "sessionKey required" });
    return;
  }
  const record = runs.get(sessionKey);
  if (record && !record.done) record.controller.abort();
  sendJson(res, 200, { ok: true });
}

// ── Router ──────────────────────────────────────────────────────────────────

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
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
          : route === "POST /v1/cancel"
            ? () => handleCancel(req, res)
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
      try {
        res.write(`${JSON.stringify({ t: "result", result: { ok: false, error: "internal_error", reason } })}\n`);
      } catch {
        /* ignore */
      }
      res.end();
    }
  });
}

// Start the gateway. HTTPS when cfg.tls is present, else HTTP. Undefined host →
// listen on all interfaces (dual-stack), so localhost, 127.0.0.1, and a remote
// OCCA all reach it. An explicit host restricts it.
export function startGateway(cfg: GatewayConfig): Server {
  config = cfg;
  const server = cfg.tls
    ? createHttpsServer({ key: cfg.tls.key, cert: cfg.tls.cert }, handleRequest)
    : createHttpServer(handleRequest);
  const scheme = cfg.tls ? "https" : "http";
  const onListen = () =>
    log("info", { scheme, host: cfg.host ?? "*", port: cfg.port }, "codex-gateway listening");
  if (cfg.host) server.listen(cfg.port, cfg.host, onListen);
  else server.listen(cfg.port, onListen);
  return server;
}
