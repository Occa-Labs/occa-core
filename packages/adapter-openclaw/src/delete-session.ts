// Delete a stored session (and its transcripts) from the OpenClaw gateway.
//
// Used by OCCA's worker after a skill install/uninstall completes — the
// install conversation lives in its own session keyed
// `agent:<id>:skill:<slug>` so it doesn't pollute the user-facing chat,
// but those sessions otherwise linger in the dashboard dropdown forever.
// Calling `sessions.delete` post-completion keeps the dropdown clean.
//
// Gateway protects the agent's main session — `sessions.delete` rejects
// with INVALID_REQUEST if you try to delete it. Callers should only ever
// pass synthetic / sub-conversation keys here.

import { connectWithAutoPair } from "./connect-with-auto-pair";
import type { DeviceIdentity } from "./keypair";

export interface DeleteSessionInput {
  gatewayUrl: string;
  apiKey: string;
  device: DeviceIdentity;
  /** Optional — gateway accepts an already-issued device token to skip pairing. */
  deviceToken?: string;
  /** Full session key, e.g. `agent:<externalAgentId>:skill:<slug>`. */
  sessionKey: string;
  /** Default true — also remove transcript files from disk. */
  deleteTranscript?: boolean;
}

export type DeleteSessionErrorCode =
  | "config_invalid"
  | "gateway_unreachable"
  | "gateway_handshake_timeout"
  | "session_main_protected"
  | "rpc_failed";

export type DeleteSessionResult =
  | { ok: true }
  | { ok: false; error: DeleteSessionErrorCode; reason?: string };

export async function deleteAgentSession(
  input: DeleteSessionInput,
  opts?: { handshakeTimeoutMs?: number; rpcTimeoutMs?: number },
): Promise<DeleteSessionResult> {
  const handshakeTimeoutMs = opts?.handshakeTimeoutMs ?? 10_000;
  const rpcTimeoutMs = opts?.rpcTimeoutMs ?? 10_000;

  let client: Awaited<ReturnType<typeof connectWithAutoPair>>["client"] | null =
    null;
  try {
    const connected = await connectWithAutoPair(
      { gatewayUrl: input.gatewayUrl, apiKey: input.apiKey },
      input.device,
      { handshakeTimeoutMs, deviceToken: input.deviceToken },
    );
    client = connected.client;

    await client.sendRpc(
      "sessions.delete",
      {
        key: input.sessionKey,
        deleteTranscript: input.deleteTranscript ?? true,
      },
      { timeoutMs: rpcTimeoutMs },
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Gateway refuses to delete the agent's main session — surface that
    // distinctly so callers don't retry.
    if (/cannot delete the main session/i.test(msg)) {
      return { ok: false, error: "session_main_protected", reason: msg };
    }
    if (/handshake|timeout/i.test(msg)) {
      return { ok: false, error: "gateway_handshake_timeout", reason: msg };
    }
    if (/connect|network|econnrefused/i.test(msg)) {
      return { ok: false, error: "gateway_unreachable", reason: msg };
    }
    return { ok: false, error: "rpc_failed", reason: msg };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        /* swallow — close errors don't affect the delete outcome */
      }
    }
  }
}
