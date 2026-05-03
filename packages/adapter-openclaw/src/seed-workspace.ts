// Seed a provisioned OpenClaw agent's workspace with per-file markdown
// content. Uses the `agents.files.set` control-plane RPC (documented under
// "Agent & Workspace Operations" in gateway/protocol).
//
// The exact param shape isn't documented, so we try the most likely forms
// in order and cache whichever works for this gateway build. Observed
// patterns in the wild:
//   1.  { agentId, name, content }                — per-file single call (confirmed)
//   2.  { agentId, files: [{ name, content }] }   — batch with name field
//   3.  { agentId, path, content }                — older alias using path
//   4.  { agentId, files: [{ path, content }] }   — batch with path field
//   5.  { id, path, content }                     — legacy alias
// If all of these fail we surface the underlying error so the caller can
// roll back the create.

import { OpenClawClient, OpenClawError } from "./client";
import { connectWithAutoPair } from "./connect-with-auto-pair";
import type { DeviceIdentity } from "./keypair";

export interface WorkspaceFileInput {
  filename: string; // e.g. "AGENTS.md"
  content: string;
}

export interface SeedWorkspaceInput {
  gatewayUrl: string;
  apiKey: string;
  device: DeviceIdentity;
  externalAgentId: string;
  files: WorkspaceFileInput[];
}

export type SeedWorkspaceErrorCode =
  | "gateway_unreachable"
  | "gateway_handshake_timeout"
  | "device_pairing_required"
  | "gateway_unauthorized"
  | "gateway_invalid_response"
  | "workspace_files_rpc_unavailable"
  | "workspace_write_failed";

export type SeedWorkspaceResult =
  | { ok: true; pushed: number }
  | { ok: false; error: SeedWorkspaceErrorCode; reason?: string };

interface RpcVariant {
  name: string;
  // Build params for a single-file push (or a batch if the variant
  // supports it). Return `null` if this variant should push batched
  // instead; `batchParams` is used in that case.
  singleParams?: (
    agentId: string,
    f: WorkspaceFileInput,
  ) => Record<string, unknown>;
  batchParams?: (
    agentId: string,
    files: WorkspaceFileInput[],
  ) => Record<string, unknown>;
}

// Ordered best-guess variants. First working one wins and is reused for the
// rest of the push. Batch form is preferred when available because it halves
// round trips and typically triggers a single gateway save.
const VARIANTS: RpcVariant[] = [
  {
    name: "batch name[]",
    batchParams: (agentId, files) => ({
      agentId,
      files: files.map((f) => ({ name: f.filename, content: f.content })),
    }),
  },
  {
    name: "single {agentId, name, content}",
    singleParams: (agentId, f) => ({
      agentId,
      name: f.filename,
      content: f.content,
    }),
  },
  {
    name: "batch files[]",
    batchParams: (agentId, files) => ({
      agentId,
      files: files.map((f) => ({ path: f.filename, content: f.content })),
    }),
  },
  {
    name: "single {agentId, path, content}",
    singleParams: (agentId, f) => ({
      agentId,
      path: f.filename,
      content: f.content,
    }),
  },
  {
    name: "single {id, path, content}",
    singleParams: (agentId, f) => ({
      id: agentId,
      path: f.filename,
      content: f.content,
    }),
  },
];

function isRejectionSignal(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes("unknown method") ||
    m.includes("method not found") ||
    m.includes("invalid params") ||
    m.includes("must have required property") ||
    m.includes("must not have additional properties") ||
    m.includes("not implemented")
  );
}

function mapErrorCode(err: unknown): SeedWorkspaceErrorCode {
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
  input: { gatewayUrl: string; apiKey: string; device: DeviceIdentity },
  handshakeTimeoutMs: number,
  fn: (client: OpenClawClient) => Promise<T>,
): Promise<T> {
  const { client } = await connectWithAutoPair(
    { gatewayUrl: input.gatewayUrl, apiKey: input.apiKey },
    input.device,
    { handshakeTimeoutMs },
  );
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

export async function seedWorkspace(
  input: SeedWorkspaceInput,
  opts?: { handshakeTimeoutMs?: number; rpcTimeoutMs?: number },
): Promise<SeedWorkspaceResult> {
  if (input.files.length === 0) return { ok: true, pushed: 0 };

  const handshakeTimeoutMs = opts?.handshakeTimeoutMs ?? 10_000;
  const rpcTimeoutMs = opts?.rpcTimeoutMs ?? 20_000;

  try {
    return await withClient(input, handshakeTimeoutMs, async (client) => {
      // First round: find which variant the gateway accepts. Try each
      // variant against the first file; on success, lock in that shape for
      // the remaining pushes. Rejection-shaped errors (unknown method,
      // invalid params) → try next variant. Transport/auth errors bubble.
      let chosen: RpcVariant | null = null;
      let lastRejection: Error | null = null;

      for (const variant of VARIANTS) {
        const first = input.files[0];
        try {
          if (variant.batchParams) {
            await client.sendRpc(
              "agents.files.set",
              variant.batchParams(input.externalAgentId, input.files),
              { timeoutMs: rpcTimeoutMs },
            );
            console.log(
              `[adapter-openclaw] seedWorkspace: variant "${variant.name}" accepted — batched ${input.files.length} files`,
            );
            return { ok: true as const, pushed: input.files.length };
          }
          if (variant.singleParams) {
            await client.sendRpc(
              "agents.files.set",
              variant.singleParams(input.externalAgentId, first),
              { timeoutMs: rpcTimeoutMs },
            );
            chosen = variant;
            console.log(
              `[adapter-openclaw] seedWorkspace: variant "${variant.name}" accepted — will push remaining ${input.files.length - 1} files`,
            );
            break;
          }
        } catch (err) {
          if (isRejectionSignal(err)) {
            lastRejection = err instanceof Error ? err : new Error(String(err));
            console.log(
              `[adapter-openclaw] seedWorkspace: variant "${variant.name}" rejected (${lastRejection.message}); trying next`,
            );
            continue;
          }
          // Non-rejection failure — surface to caller.
          throw err;
        }
      }

      if (!chosen) {
        return {
          ok: false,
          error: "workspace_files_rpc_unavailable",
          reason:
            lastRejection?.message ?? "no agents.files.set variant accepted",
        } as const;
      }

      // Push the rest using the winning single-file variant.
      for (let i = 1; i < input.files.length; i += 1) {
        const f = input.files[i];
        try {
          await client.sendRpc(
            "agents.files.set",
            chosen.singleParams!(input.externalAgentId, f),
            { timeoutMs: rpcTimeoutMs },
          );
        } catch (err) {
          return {
            ok: false,
            error: "workspace_write_failed",
            reason: `failed to push ${f.filename}: ${err instanceof Error ? err.message : String(err)}`,
          } as const;
        }
      }

      console.log(
        `[adapter-openclaw] seedWorkspace: pushed ${input.files.length} files for agent=${input.externalAgentId}`,
      );
      return { ok: true as const, pushed: input.files.length };
    });
  } catch (err) {
    return {
      ok: false,
      error: mapErrorCode(err),
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
