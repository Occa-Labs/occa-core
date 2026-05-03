// Provision / deprovision an agent inside an OpenClaw gateway via the
// `config.patch` RPC. Each OCCA agent corresponds 1:1 with an OpenClaw agent
// entry under `agents.list[]`, with a dedicated workspace directory.
//
// Routing to the right agent at run time is done through the sessionKey
// prefix `agent:<externalAgentId>:…` (see execute.ts), not through an
// `agentId` param on the `agent` RPC.

import { OpenClawClient, OpenClawError } from "./client";
import { connectWithAutoPair } from "./connect-with-auto-pair";
import type { DeviceIdentity } from "./keypair";

export interface ProvisionAgentInput {
  gatewayUrl: string;
  apiKey: string;
  device: DeviceIdentity;
  desiredId: string;
  workspacePath: string;
  /**
   * Previously-issued device token. When present, sent on every connect
   * during provision so the gateway resolves the existing pair and skips
   * approval prompts. Updated value (if rotated) is returned in the result
   * so the caller can persist it.
   */
  deviceToken?: string;
}

export interface ProvisionAgentOk {
  ok: true;
  externalAgentId: string;
  workspacePath: string;
  /** Most recent device token observed during provision. Persist it. */
  deviceToken?: string;
}

export type ProvisionAgentErrorCode =
  | "gateway_unreachable"
  | "gateway_handshake_timeout"
  | "device_pairing_required"
  | "gateway_unauthorized"
  | "gateway_invalid_response"
  | "config_get_failed"
  | "config_patch_failed"
  | "agent_id_conflict"
  | "gateway_restart_timeout";

export interface ProvisionAgentFail {
  ok: false;
  error: ProvisionAgentErrorCode;
  reason?: string;
}

export type ProvisionAgentResult = ProvisionAgentOk | ProvisionAgentFail;

export interface DeprovisionAgentInput {
  gatewayUrl: string;
  apiKey: string;
  device: DeviceIdentity;
  externalAgentId: string;
  deviceToken?: string;
}

export type DeprovisionAgentResult =
  | { ok: true }
  | { ok: false; error: ProvisionAgentErrorCode; reason?: string };

export interface ListGatewayAgentsInput {
  gatewayUrl: string;
  apiKey: string;
  device: DeviceIdentity;
}

export interface ListGatewayAgentsOk {
  ok: true;
  agents: Array<{ id: string; workspace?: string | null }>;
}

export type ListGatewayAgentsResult =
  | ListGatewayAgentsOk
  | { ok: false; error: ProvisionAgentErrorCode; reason?: string };

interface AgentEntry {
  id: string;
  workspace?: string;
  [k: string]: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

// Walk the response tree and return the first non-empty string value stored
// under one of `candidateKeys`. We walk `raw` and `hash` independently
// because gateway versions have moved them between envelopes (top-level
// vs. nested under `snapshot`/`config`/`payload`) and they may not be
// co-located.
function findStringField(res: unknown, candidateKeys: string[]): string | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [res];
  while (stack.length > 0) {
    const cur = stack.pop();
    const rec = asRecord(cur);
    if (!rec) continue;
    if (seen.has(rec)) continue;
    seen.add(rec);
    for (const key of candidateKeys) {
      const v = rec[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
    // Recurse into every nested object/array to survive unknown envelopes.
    for (const v of Object.values(rec)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
}

function collectTopLevelKeys(res: unknown): string[] {
  const rec = asRecord(res);
  return rec ? Object.keys(rec) : [];
}

function readAgentsList(parsedConfig: Record<string, unknown>): AgentEntry[] {
  const agents = asRecord(parsedConfig.agents);
  const list = agents?.list;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => asRecord(item))
    .filter((r): r is Record<string, unknown> => !!r && typeof r.id === "string")
    .map((r) => ({ ...(r as AgentEntry) }));
}

function buildPatchRaw(nextList: AgentEntry[]): string {
  // JSON merge patch semantics: arrays replace entirely, so we send the full
  // updated agents.list. Other keys under agents/* stay untouched because we
  // only set agents.list in the patch root.
  return JSON.stringify({ agents: { list: nextList } });
}

function previewJson(v: unknown, max = 800): string {
  try {
    const s = JSON.stringify(v);
    if (!s) return String(v);
    return s.length > max ? `${s.slice(0, max)}…(${s.length} chars)` : s;
  } catch {
    return String(v);
  }
}

function mapErrorCode(err: unknown): ProvisionAgentErrorCode {
  if (err instanceof OpenClawError) {
    switch (err.code) {
      case "gateway_unreachable":
      case "gateway_handshake_timeout":
      case "device_pairing_required":
      case "gateway_unauthorized":
      case "gateway_invalid_response":
        return err.code;
    }
  }
  return "gateway_invalid_response";
}

async function withClient<T>(
  input: {
    gatewayUrl: string;
    apiKey: string;
    device: DeviceIdentity;
    deviceToken?: string;
  },
  handshakeTimeoutMs: number,
  fn: (client: OpenClawClient) => Promise<T>,
  onDeviceToken?: (token: string) => void,
): Promise<T> {
  const { client, hello } = await connectWithAutoPair(
    { gatewayUrl: input.gatewayUrl, apiKey: input.apiKey },
    input.device,
    { handshakeTimeoutMs, deviceToken: input.deviceToken },
  );
  if (hello.deviceToken && onDeviceToken) onDeviceToken(hello.deviceToken);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// Certain config.patch calls trigger a gateway restart; the WS closes before
// the RPC response arrives. The error surfaces as a native Error with
// "Connection closed: service restart" message. Match on both the restart
// signal and plain closures so we can enter verification mode after either.
function isRestartSignal(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("service restart") ||
    msg.includes("connection closed: restart") ||
    msg.includes("gateway restart") ||
    msg.includes("restart requested")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GatewayConfigSnapshot {
  // Authoritative parsed config from the gateway. Some gateway builds set
  // `raw: null` (the on-disk JSON5 source isn't materialised) but always
  // populate `parsed` with the in-memory object — so we read agents.list
  // straight from here instead of round-tripping through JSON5 text.
  parsedConfig: Record<string, unknown>;
  baseHash: string;
}

// Pull the first object-valued field under one of `candidateKeys` by walking
// the response tree. Mirrors findStringField but for the `parsed` config
// object (observed shape on this build of OpenClaw).
function findObjectField(
  res: unknown,
  candidateKeys: string[],
): Record<string, unknown> | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [res];
  while (stack.length > 0) {
    const cur = stack.pop();
    const rec = asRecord(cur);
    if (!rec) continue;
    if (seen.has(rec)) continue;
    seen.add(rec);
    for (const key of candidateKeys) {
      const v = rec[key];
      const obj = asRecord(v);
      if (obj) return obj;
    }
    for (const v of Object.values(rec)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
}

async function fetchConfig(
  client: OpenClawClient,
  rpcTimeoutMs: number,
  opts: { debugLabel?: string } = {},
): Promise<GatewayConfigSnapshot> {
  const res = await client.sendRpc("config.get", {}, {
    timeoutMs: rpcTimeoutMs,
  });
  const label = opts.debugLabel ?? "config.get";
  // Observed OpenClaw shape: { path, exists, raw (nullable), parsed, hash, … }.
  // `parsed` carries the authoritative in-memory config object — we prefer
  // it over `raw` (which is often null when the file lives only in memory).
  // We still probe alternate key names to survive build drift.
  const parsedConfig = findObjectField(res, [
    "parsed",
    "runtimeConfig",
    "resolved",
    "config",
  ]);
  const baseHash = findStringField(res, ["hash", "configHash", "baseHash"]);
  if (!baseHash) {
    const topKeys = collectTopLevelKeys(res);
    const preview = previewJson(res);
    console.warn(
      `[adapter-openclaw] ${label}: missing hash in response. top-level keys=[${topKeys.join(", ")}] preview=${preview}`,
    );
    throw new Error(
      `config.get missing hash (top-level keys: [${topKeys.join(", ")}]; preview: ${preview})`,
    );
  }
  if (!parsedConfig) {
    const topKeys = collectTopLevelKeys(res);
    console.warn(
      `[adapter-openclaw] ${label}: no parsed config object found. top-level keys=[${topKeys.join(", ")}] preview=${previewJson(res)}`,
    );
  }
  console.log(
    `[adapter-openclaw] ${label}: parsed=${parsedConfig ? "object" : "null"} hash=${baseHash.slice(0, 16)}…`,
  );
  return { parsedConfig: parsedConfig ?? {}, baseHash };
}

// Poll config.get until the agent with `expectedId` appears in agents.list (or
// disappears, when `expectedPresent` is false). Used after the gateway resets
// the WS on a patch-triggered restart so we can confirm the patch actually
// landed before calling provisioning successful.
async function waitForAgentListState(
  input: {
    gatewayUrl: string;
    apiKey: string;
    device: DeviceIdentity;
    deviceToken?: string;
  },
  expectedId: string,
  expectedPresent: boolean,
  opts: {
    totalTimeoutMs: number;
    pollIntervalMs: number;
    handshakeTimeoutMs: number;
    rpcTimeoutMs: number;
  },
  onDeviceToken?: (token: string) => void,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const deadline = Date.now() + opts.totalTimeoutMs;
  let lastReason = "gateway did not respond in time";
  let pollCount = 0;
  while (Date.now() < deadline) {
    pollCount += 1;
    try {
      const outcome = await withClient(
        input,
        opts.handshakeTimeoutMs,
        async (c) => {
          const snap = await fetchConfig(c, opts.rpcTimeoutMs, {
            debugLabel: `config.get verify#${pollCount}`,
          });
          const list = readAgentsList(snap.parsedConfig);
          const ids = list.map((a) => a.id).join(",");
          const present = list.some((a) => a.id === expectedId);
          console.log(
            `[adapter-openclaw] verify poll#${pollCount}: expectedId=${expectedId} present=${present} expectedPresent=${expectedPresent} listSize=${list.length} ids=[${ids}]`,
          );
          return { present, listSize: list.length, ids };
        },
        onDeviceToken,
      );
      if (outcome.present === expectedPresent) return { ok: true };
      lastReason = expectedPresent
        ? `gateway config still missing agent id=${expectedId} (saw ${outcome.listSize} agents: [${outcome.ids}])`
        : `gateway config still contains agent id=${expectedId}`;
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
    }
    await sleep(opts.pollIntervalMs);
  }
  return { ok: false, reason: lastReason };
}

export async function provisionAgent(
  input: ProvisionAgentInput,
  opts?: {
    handshakeTimeoutMs?: number;
    rpcTimeoutMs?: number;
    restartTotalTimeoutMs?: number;
    restartPollIntervalMs?: number;
    onStep?: (event: "restart_detected" | "restart_verified") => void;
  },
): Promise<ProvisionAgentResult> {
  const handshakeTimeoutMs = opts?.handshakeTimeoutMs ?? 10_000;
  const rpcTimeoutMs = opts?.rpcTimeoutMs ?? 15_000;
  const restartTotalTimeoutMs = opts?.restartTotalTimeoutMs ?? 60_000;
  const restartPollIntervalMs = opts?.restartPollIntervalMs ?? 2_000;

  let patchSawRestart = false;

  // Track the latest device token issued by the gateway across the multiple
  // connect/reconnect cycles inside this provision call. Initial value is
  // whatever the caller passed in; mutated whenever a hello-ok carries a
  // newer (rotated) token.
  let latestDeviceToken: string | undefined = input.deviceToken;
  const captureToken = (token: string) => {
    if (token && token !== latestDeviceToken) latestDeviceToken = token;
  };

  try {
    const provisionResult = await withClient(
      input,
      handshakeTimeoutMs,
      async (client) => {
        let snapshot: GatewayConfigSnapshot;
        try {
          snapshot = await fetchConfig(client, rpcTimeoutMs, {
            debugLabel: "config.get initial",
          });
        } catch (err) {
          return {
            ok: false,
            error: "config_get_failed",
            reason: err instanceof Error ? err.message : String(err),
          } as const;
        }

        const list = readAgentsList(snapshot.parsedConfig);
        const existingIds = list.map((a) => a.id).join(",");
        console.log(
          `[adapter-openclaw] existing agents.list: size=${list.length} ids=[${existingIds}]`,
        );
        const existing = list.find((a) => a.id === input.desiredId);
        if (existing) {
          // Idempotent retry path: a previous provision attempt for THIS
          // agent already committed the entry on gateway (e.g. config patch
          // applied but verify timed out, leaving the OCCA-side row with
          // a NULL externalAgentId). Skip the patch + restart cycle and
          // fall through to verification.
          //
          // No workspace-path equality check: gateway stores expanded paths
          // (`/root/.openclaw/...`) while we send tilde paths (`~/.openclaw/...`),
          // so naive string compare gives false positives. desiredId is a
          // UUID-derived per-agent identifier — collision implies the same
          // agent regardless of stored path representation.
          console.log(
            `[adapter-openclaw] idempotent: agent ${input.desiredId} already configured (gateway workspace=${existing.workspace ?? "n/a"}) — skipping patch`,
          );
          return { ok: "committed" } as const;
        }

        const nextList: AgentEntry[] = [
          ...list,
          { id: input.desiredId, workspace: input.workspacePath },
        ];
        const patchRaw = buildPatchRaw(nextList);
        console.log(
          `[adapter-openclaw] sending config.patch: baseHash=${snapshot.baseHash.slice(0, 16)}… raw=${patchRaw.slice(0, 500)}`,
        );

        let patchResponse: unknown;
        try {
          patchResponse = await client.sendRpc(
            "config.patch",
            { raw: patchRaw, baseHash: snapshot.baseHash },
            { timeoutMs: rpcTimeoutMs },
          );
        } catch (err) {
          if (isRestartSignal(err)) {
            // The gateway applied the patch and restarted before the RPC
            // response could land. Fall through to verification-by-polling
            // outside the current (dead) WS.
            console.log(
              `[adapter-openclaw] config.patch: restart signal received — will verify via reconnect polling`,
            );
            patchSawRestart = true;
            opts?.onStep?.("restart_detected");
            return { ok: "restart" } as const;
          }
          console.warn(
            `[adapter-openclaw] config.patch failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return {
            ok: false,
            error: "config_patch_failed",
            reason: err instanceof Error ? err.message : String(err),
          } as const;
        }

        console.log(
          `[adapter-openclaw] config.patch response: ${previewJson(patchResponse)}`,
        );

        // Best-effort in-connection verify: immediately after a clean patch
        // response, re-read config on the same WS. If the agent is already
        // present here, we can skip the reconnect-and-poll loop entirely.
        // Any failure is non-fatal — we fall through to polling.
        try {
          const postSnap = await fetchConfig(client, rpcTimeoutMs, {
            debugLabel: "config.get post-patch",
          });
          const postList = readAgentsList(postSnap.parsedConfig);
          const postPresent = postList.some((a) => a.id === input.desiredId);
          console.log(
            `[adapter-openclaw] post-patch read: present=${postPresent} listSize=${postList.length} ids=[${postList.map((a) => a.id).join(",")}]`,
          );
        } catch (err) {
          console.warn(
            `[adapter-openclaw] post-patch config.get failed (will still poll): ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        console.log(
          `[adapter-openclaw] provisioned agent id=${input.desiredId} workspace=${input.workspacePath}`,
        );
        return { ok: "committed" } as const;
      },
      captureToken,
    );

    if (provisionResult.ok === false) {
      return provisionResult;
    }

    // Either the patch returned cleanly (committed) or the WS died on us
    // mid-restart. In both cases, confirm the final state by reconnecting and
    // re-reading the config — cheap insurance and required for the restart
    // path. On restart we tolerate a longer deadline to let the gateway come
    // back online.
    const verifyTimeout = patchSawRestart ? restartTotalTimeoutMs : 10_000;
    const verify = await waitForAgentListState(
      input,
      input.desiredId,
      true,
      {
        totalTimeoutMs: verifyTimeout,
        pollIntervalMs: restartPollIntervalMs,
        handshakeTimeoutMs,
        rpcTimeoutMs,
      },
      captureToken,
    );
    if (!verify.ok) {
      return {
        ok: false,
        error: patchSawRestart ? "gateway_restart_timeout" : "config_patch_failed",
        reason: verify.reason,
      };
    }

    if (patchSawRestart) {
      opts?.onStep?.("restart_verified");
      console.log(
        `[adapter-openclaw] provision verified after restart id=${input.desiredId}`,
      );
    }

    return {
      ok: true,
      externalAgentId: input.desiredId,
      workspacePath: input.workspacePath,
      deviceToken: latestDeviceToken,
    };
  } catch (err) {
    return {
      ok: false,
      error: mapErrorCode(err),
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function deprovisionAgent(
  input: DeprovisionAgentInput,
  opts?: {
    handshakeTimeoutMs?: number;
    rpcTimeoutMs?: number;
    restartTotalTimeoutMs?: number;
    restartPollIntervalMs?: number;
  },
): Promise<DeprovisionAgentResult> {
  const handshakeTimeoutMs = opts?.handshakeTimeoutMs ?? 10_000;
  const rpcTimeoutMs = opts?.rpcTimeoutMs ?? 15_000;
  const restartTotalTimeoutMs = opts?.restartTotalTimeoutMs ?? 60_000;
  const restartPollIntervalMs = opts?.restartPollIntervalMs ?? 2_000;

  let patchSawRestart = false;

  try {
    const inner = await withClient(input, handshakeTimeoutMs, async (client) => {
      let snapshot: GatewayConfigSnapshot;
      try {
        snapshot = await fetchConfig(client, rpcTimeoutMs);
      } catch (err) {
        return {
          ok: false,
          error: "config_get_failed",
          reason: err instanceof Error ? err.message : String(err),
        } as const;
      }

      const list = readAgentsList(snapshot.parsedConfig);
      const present = list.some((a) => a.id === input.externalAgentId);

      if (!present) {
        console.log(
          `[adapter-openclaw] deprovision noop: id=${input.externalAgentId} not present`,
        );
        return { ok: "noop" } as const;
      }

      // Prefer the dedicated `agents.delete` RPC — observed behaviour on
      // this gateway build shows that shrinking `agents.list` via
      // `config.patch` resolves ok but does not actually commit (config hash
      // stays identical). `agents.delete` is called out in the RPC reference
      // and looks like the intended remove path; shape isn't documented so
      // we probe variants the same way we do for agents.files.set.
      const deleteVariants: Array<(id: string) => Record<string, unknown>> = [
        (id) => ({ agentId: id }),
        (id) => ({ id }),
      ];
      let agentsDeleteSupported = false;
      let agentsDeleteOk = false;
      let lastRejection: string | null = null;
      for (const build of deleteVariants) {
        const params = build(input.externalAgentId);
        try {
          const resp = await client.sendRpc("agents.delete", params, {
            timeoutMs: rpcTimeoutMs,
          });
          agentsDeleteSupported = true;
          agentsDeleteOk = true;
          console.log(
            `[adapter-openclaw] agents.delete ${previewJson(params)} -> ${previewJson(resp)}`,
          );
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Method-not-found style errors mean this gateway build doesn't
          // expose agents.delete — fall through to config.patch. Anything
          // else (invalid_params, etc.) means the method exists but the
          // shape is wrong; try the next variant.
          if (
            /unknown method|method not found|not implemented/i.test(msg)
          ) {
            console.log(
              `[adapter-openclaw] agents.delete unavailable on this gateway; falling back to config.patch`,
            );
            break;
          }
          agentsDeleteSupported = true;
          lastRejection = msg;
          console.log(
            `[adapter-openclaw] agents.delete ${previewJson(params)} rejected: ${msg}`,
          );
        }
      }

      if (agentsDeleteSupported && agentsDeleteOk) {
        console.log(
          `[adapter-openclaw] deprovisioned agent id=${input.externalAgentId} via agents.delete`,
        );
        return { ok: "committed" } as const;
      }
      if (agentsDeleteSupported && !agentsDeleteOk) {
        // Method exists but no variant accepted. Surface the last rejection
        // so the caller can see what the schema expects.
        return {
          ok: false,
          error: "config_patch_failed",
          reason: `agents.delete variants rejected: ${lastRejection ?? "unknown"}`,
        } as const;
      }

      // Fallback: legacy config.patch list-replacement.
      const filtered = list.filter((a) => a.id !== input.externalAgentId);
      try {
        const patchRaw = buildPatchRaw(filtered);
        console.log(
          `[adapter-openclaw] sending config.patch (remove): baseHash=${snapshot.baseHash.slice(0, 16)}… listSize=${filtered.length}`,
        );
        const patchResp = await client.sendRpc(
          "config.patch",
          { raw: patchRaw, baseHash: snapshot.baseHash },
          { timeoutMs: rpcTimeoutMs },
        );
        console.log(
          `[adapter-openclaw] config.patch (remove) response: ${previewJson(patchResp)}`,
        );
      } catch (err) {
        if (isRestartSignal(err)) {
          patchSawRestart = true;
          return { ok: "restart" } as const;
        }
        return {
          ok: false,
          error: "config_patch_failed",
          reason: err instanceof Error ? err.message : String(err),
        } as const;
      }

      console.log(
        `[adapter-openclaw] deprovisioned agent id=${input.externalAgentId} via config.patch`,
      );
      return { ok: "committed" } as const;
    });

    if (inner.ok === false) return inner;
    if (inner.ok === "noop") return { ok: true };

    const verifyTimeout = patchSawRestart ? restartTotalTimeoutMs : 5_000;
    const verify = await waitForAgentListState(
      input,
      input.externalAgentId,
      false,
      {
        totalTimeoutMs: verifyTimeout,
        pollIntervalMs: restartPollIntervalMs,
        handshakeTimeoutMs,
        rpcTimeoutMs,
      },
    );
    if (!verify.ok) {
      return {
        ok: false,
        error: patchSawRestart ? "gateway_restart_timeout" : "config_patch_failed",
        reason: verify.reason,
      };
    }

    if (patchSawRestart) {
      console.log(
        `[adapter-openclaw] deprovision verified after restart id=${input.externalAgentId}`,
      );
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: mapErrorCode(err),
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// Read-only companion to provision/deprovision. Used by the dev GC endpoint
// to diff the gateway's agents.list against the OCCA DB and find orphans.
export async function listGatewayAgents(
  input: ListGatewayAgentsInput,
  opts?: { handshakeTimeoutMs?: number; rpcTimeoutMs?: number },
): Promise<ListGatewayAgentsResult> {
  const handshakeTimeoutMs = opts?.handshakeTimeoutMs ?? 10_000;
  const rpcTimeoutMs = opts?.rpcTimeoutMs ?? 15_000;
  try {
    const entries = await withClient(input, handshakeTimeoutMs, async (client) => {
      const snap = await fetchConfig(client, rpcTimeoutMs, {
        debugLabel: "config.get list",
      });
      return readAgentsList(snap.parsedConfig);
    });
    return {
      ok: true,
      agents: entries.map((e) => ({
        id: e.id,
        workspace:
          typeof e.workspace === "string" ? e.workspace : e.workspace ? null : null,
      })),
    };
  } catch (err) {
    return {
      ok: false,
      error: mapErrorCode(err),
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
