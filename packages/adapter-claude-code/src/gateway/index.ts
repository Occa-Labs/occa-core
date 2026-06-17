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
  claudeAvailable,
  sessionUuidFromKey,
  type ClaudeStreamEvent,
  type RunClaudeResult,
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
  // Cheap liveness only (claude binary present + this request proves the
  // gateway is up and the bearer is valid). No real `claude -p` inference —
  // the connection probe hits this every 90s per agent, so a model round-trip
  // here would burn tokens and flap on slow/cold spawns.
  const probe = await claudeAvailable();
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

// ── Run registry ──────────────────────────────────────────────────────────
//
// A run is DECOUPLED from the HTTP connection that started it. Stream events
// and the final result are buffered per `sessionKey`, so a client whose
// connection drops mid-run (OCCA server restart, idle proxy timeout, network
// blip) can RE-POST /v1/run with the same sessionKey and resume from where it
// left off — the underlying `claude -p` keeps running. Previously any blip
// fired `res.on("close")` → aborted the process → discarded minutes of work
// AND surfaced as `gateway_unreachable` on OCCA's side.
interface RunRecord {
  events: ClaudeStreamEvent[];
  result: RunClaudeResult | null;
  done: boolean;
  controller: AbortController;
  subscribers: Set<ServerResponse>;
  evictTimer: ReturnType<typeof setTimeout> | null;
}

const runs = new Map<string, RunRecord>();

// Keep a completed run's result available this long for a reconnecting
// client, then evict so a later re-dispatch on the same sessionKey starts
// fresh instead of replaying a stale result.
const COMPLETED_TTL_MS = 60_000;

function writeLine(res: ServerResponse, obj: unknown): void {
  try {
    res.write(`${JSON.stringify(obj)}\n`);
  } catch {
    /* dead socket — the subscriber dropped; harmless */
  }
}

// Attach an HTTP response to a run: replay buffered events from `fromIndex`
// (what the reconnecting client hasn't seen), then either flush the result
// (run already finished) or subscribe to live events.
function attachSubscriber(
  record: RunRecord,
  res: ServerResponse,
  fromIndex: number,
): void {
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

  const resumeCursor =
    typeof body.resumeCursor === "number" ? body.resumeCursor : 0;

  // Resume path: a run already exists for this sessionKey (in-flight or just
  // completed within the TTL) → attach this connection to it instead of
  // spawning a second claude process. This is what makes a dropped
  // connection recoverable.
  const existing = runs.get(sessionKey);
  if (existing) {
    attachSubscriber(existing, res, resumeCursor);
    return;
  }

  // Fresh run.
  const record: RunRecord = {
    events: [],
    result: null,
    done: false,
    controller: new AbortController(),
    subscribers: new Set(),
    evictTimer: null,
  };
  runs.set(sessionKey, record);
  attachSubscriber(record, res, 0);

  const started = Date.now();
  log(
    "info",
    { externalAgentId, model, sessionKey, promptChars: prompt.length },
    "run start",
  );

  // We deliberately do NOT abort on client disconnect — the run is bounded
  // by `timeoutMs` (server-side wall clock), so an abandoned run still
  // terminates, and meanwhile a reconnecting client can resume it.
  // Cancellation is explicit via POST /v1/cancel.
  const result = await runClaude({
    prompt,
    cwd: workspacePathFor(externalAgentId),
    model,
    sessionUuid: sessionUuidFromKey(sessionKey),
    appendSystemPrompt: asString(body.appendSystemPrompt),
    allowedTools: asStringArray(body.allowedTools),
    disallowedTools: asStringArray(body.disallowedTools),
    timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
    maxBudgetUsd:
      typeof body.maxBudgetUsd === "number" ? body.maxBudgetUsd : undefined,
    signal: record.controller.signal,
    onEvent: (event: ClaudeStreamEvent) => {
      record.events.push(event);
      for (const sub of record.subscribers) writeLine(sub, { t: "event", event });
    },
  });

  record.result = result;
  record.done = true;
  log(
    "info",
    { externalAgentId, sessionKey, durationMs: Date.now() - started },
    "run done",
  );
  for (const sub of record.subscribers) {
    writeLine(sub, { t: "result", result });
    try {
      sub.end();
    } catch {
      /* ignore */
    }
  }
  record.subscribers.clear();
  record.evictTimer = setTimeout(() => runs.delete(sessionKey), COMPLETED_TTL_MS);
}

// POST /v1/cancel — explicit cancellation. A dropped connection no longer
// kills a run (so it can be resumed), so the OCCA side calls this when the
// dispatcher genuinely aborts (user cancel / shutdown).
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

// Undefined host → listen on all interfaces (dual-stack), so localhost,
// 127.0.0.1, and a remote OCCA all reach it. An explicit host restricts it.
const onListen = () =>
  log("info", { host: config.host ?? "*", port: config.port }, "claude-gateway listening");
if (config.host) server.listen(config.port, config.host, onListen);
else server.listen(config.port, onListen);
