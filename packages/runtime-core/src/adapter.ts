// Agent-agnostic adapter contract. Concrete adapters (openclaw, claude-cli,
// cursor, etc.) implement this interface and register themselves in the
// dispatcher's adapter registry. The dispatcher is the only caller.

import type {
  LivenessState,
  TraceStatus,
  TraceUsage,
} from "@occa/shared/types";
import type {
  AdapterTraceResult,
  RuntimeEnv,
  WakePayload,
} from "./wake-payload";

export interface AdapterTraceEvent {
  type: string; // "chunk" | "tool_call" | "status" | "error" | ...
  stream?: "stdout" | "stderr";
  level?: string;
  message?: string;
  payload?: Record<string, unknown>;
}

// Assigned-skill view passed wake-time. Markdown is included so adapters that
// want to inline it in the wake prompt can do so without a round-trip; adapters
// that prefer lazy fetch can drop it and just surface the key list.
export interface AssignedSkill {
  key: string;
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
}

// Persona / workspace markdown the agent's identity lives in. For
// adapters that run the agent on their own filesystem (OpenClaw) these
// files were pushed via `seedWorkspace` and the agent reads them with
// its read_file tool. For adapters that don't have a per-agent filesystem
// (Hermes' HTTP gateway), the content needs to ride inside the wake
// prompt — otherwise the agent fires read_file calls that fail.
export interface WorkspaceFile {
  filename: string;
  content: string;
}

export interface AdapterExecutionContext {
  payload: WakePayload;
  adapterConfig: Record<string, unknown>;
  runtimeEnv: RuntimeEnv;
  signal: AbortSignal;
  onEvent: (event: AdapterTraceEvent) => void;
  onLivenessHint: (state: LivenessState) => void;
  sessionParams: Record<string, unknown> | null;
  skills: AssignedSkill[];
  workspaceFiles: WorkspaceFile[];
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  info?: Record<string, unknown>;
}

// ── Provision lifecycle types ─────────────────────────────────────────────────
// Used by the create-agent pipeline (server/services/agent-create.ts).
// Each method maps to one phase of the lifecycle so adapters only need to
// know about their own protocol — the server orchestrates the DB operations.

export type PrepareCredentialsResult =
  | {
      ok: true;
      /** Adapter-specific fields merged into adapterConfig before DB insert.
       * openclaw: { deviceKeypair, deviceToken? }
       * claude-code: {} (API key stays in baseConfig as-is)
       */
      configPatch: Record<string, unknown>;
    }
  | { ok: false; error: string; reason?: string };

export interface AdapterProvisionInput {
  /** Full adapterConfig after prepareCredentials configPatch was merged in. */
  adapterConfig: Record<string, unknown>;
  /** Desired identifier on the adapter side (e.g. "occa-a1b2c3d4"). */
  desiredExternalId: string;
  /** Desired workspace directory. Adapter may override in the result. */
  workspacePath: string;
  /**
   * Optional progress events emitted during provisioning. Adapters that
   * have multi-step internal flows (e.g. OpenClaw's gateway-restart
   * waiting window) use this to surface user-facing substeps to the
   * onboarding SSE stream. Adapters with no substeps simply omit it.
   * `kind` lets future events extend without breaking callers.
   */
  onEvent?: (event: {
    kind: "step";
    step: string;
    label?: string;
    status: "running" | "done";
  }) => void;
}

export type AdapterProvisionResult =
  | {
      ok: true;
      externalAgentId: string;
      workspacePath: string;
      /** Additional fields merged into adapterConfig after provision.
       * openclaw: { openclawAgentId, workspacePath, deviceToken? }
       */
      configPatch: Record<string, unknown>;
    }
  | { ok: false; error: string; reason?: string };

export interface AdapterDeprovisionInput {
  adapterConfig: Record<string, unknown>;
  externalAgentId: string;
}

export interface AdapterSeedInput {
  adapterConfig: Record<string, unknown>;
  externalAgentId: string;
  files: Array<{ filename: string; content: string }>;
}

export type AdapterSeedResult =
  | { ok: true; pushed: number }
  | { ok: false; error: string; reason?: string };

// ── Direct prompt / task execution ───────────────────────────────────────────
// Used by the server task-dispatcher (server/services/task-dispatcher.ts).
// Distinct from executeTrace (used by the worker) — the dispatcher sends a
// single prompt and streams the response; the worker runs a full wake cycle.

export interface AdapterSendPromptInput {
  adapterConfig: Record<string, unknown>;
  externalAgentId: string;
  /** Full session key, e.g. "agent:{id}:task:{traceId}". */
  sessionKey: string;
  message: string;
  onEvent?: (stream: string, data: Record<string, unknown>) => void;
  waitTimeoutMs?: number;
  /** Optional hard spend ceiling for this single run, in USD. OCCA's
   *  budget model gates at dispatch time (monthly pool) rather than
   *  truncating live runs, so this is left undefined in normal operation.
   *  Kept in the contract for adapters/callers that want a per-run cap.
   *  Undefined → no per-run cap. */
  maxBudgetUsd?: number;
}

export type AdapterSendPromptResult =
  | {
      ok: true;
      reply: string;
      /** Token/cost accounting for this turn, when the adapter's gateway
       *  reports it. The task dispatcher persists this to the trace's
       *  usageJson + the deployment's running totals. Undefined/null when
       *  the adapter can't surface usage (e.g. openclaw gateway). */
      usage?: TraceUsage | null;
    }
  | { ok: false; error: string; reason?: string };

// ── Session reset ────────────────────────────────────────────────────────────
// Wipes the adapter-side conversation memory for a session key. Used when
// the user clears a chat thread — the OCCA-side messages are deleted, and
// this drops the agent's gateway-side memory so the next turn starts fresh.

export interface AdapterResetSessionInput {
  adapterConfig: Record<string, unknown>;
  /** Full session key whose conversation memory should be wiped. */
  sessionKey: string;
}

export type AdapterResetSessionResult =
  | { ok: true }
  | { ok: false; error: string; reason?: string };

// Whether the adapter preserves per-sessionKey conversation memory on
// its own side (OpenClaw: yes — gateway holds chat history per session
// key) or treats each request as a fresh stateless call (Hermes: yes —
// /v1/chat/completions is one-shot, no session bound to the key).
//
// Callers branch on this to decide whether to:
//   - rely on adapter-side memory for prior turns (preserved), or
//   - render full conversation context into every prompt (stateless).
//
// Forbidden: hardcoding `adapter.type === "hermes"` outside the adapter
// package. Always read this flag from the registered adapter.
export type AdapterSessionMemory = "preserved" | "stateless";

export interface AgentAdapter {
  type: string;
  sessionMemory: AdapterSessionMemory;

  // ── Connection check ────────────────────────────────────────────────────
  probeConnection(config: Record<string, unknown>): Promise<ProbeResult>;

  // ── Provision lifecycle ─────────────────────────────────────────────────
  /** Step 1: validate base creds, generate adapter-internal credentials.
   *  Returns configPatch merged into adapterConfig before DB insert. */
  prepareCredentials(
    baseConfig: Record<string, unknown>,
  ): Promise<PrepareCredentialsResult>;
  /** Step 2: create agent entity on the adapter side. */
  provision(input: AdapterProvisionInput): Promise<AdapterProvisionResult>;
  /** Cleanup — called on rollback or agent delete. Best-effort. */
  deprovision(input: AdapterDeprovisionInput): Promise<void>;
  /** Step 3: push initial workspace files to the agent. */
  seedWorkspace(input: AdapterSeedInput): Promise<AdapterSeedResult>;

  // ── Task execution ──────────────────────────────────────────────────────
  /** Send a single prompt and stream back the reply (server dispatcher). */
  sendPrompt(input: AdapterSendPromptInput): Promise<AdapterSendPromptResult>;
  /** Run a full wake/trace cycle (worker dispatcher). */
  executeTrace(ctx: AdapterExecutionContext): Promise<AdapterTraceResult>;

  // ── Session lifecycle ───────────────────────────────────────────────────
  /** Wipe the adapter-side conversation memory for a session key.
   *  Best-effort — callers treat failure as non-fatal. */
  resetSession(
    input: AdapterResetSessionInput,
  ): Promise<AdapterResetSessionResult>;
}

// Re-exports so callers don't have to import from multiple subpaths.
export type {
  AdapterTraceResult,
  WakePayload,
  RuntimeEnv,
} from "./wake-payload";
export type { LivenessState, TraceStatus, TraceUsage };
