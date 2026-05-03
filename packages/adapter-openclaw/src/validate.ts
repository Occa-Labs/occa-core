import { OpenClawError } from "./client";
import { connectWithAutoPair } from "./connect-with-auto-pair";
import type { DeviceIdentity } from "./keypair";

export interface ValidateKeypairOk {
  ok: true;
  grantedScopes: string[];
  connId: string | null;
  pairedRequestId?: string;
  /** Latest device token observed during validate. Persist it. */
  deviceToken?: string;
}

export type ValidateKeypairErrorCode =
  | "gateway_unreachable"
  | "gateway_handshake_timeout"
  | "device_pairing_required"
  | "gateway_unauthorized"
  | "gateway_invalid_response";

export interface ValidateKeypairFail {
  ok: false;
  error: ValidateKeypairErrorCode;
  reason?: string;
}

export type ValidateKeypairResult = ValidateKeypairOk | ValidateKeypairFail;

export async function validateDeviceKeypair(
  config: { gatewayUrl: string; apiKey: string },
  device: DeviceIdentity,
  opts?: { handshakeTimeoutMs?: number; deviceToken?: string },
): Promise<ValidateKeypairResult> {
  try {
    const { client, hello, pairedRequestId } = await connectWithAutoPair(
      config,
      device,
      {
        handshakeTimeoutMs: opts?.handshakeTimeoutMs,
        deviceToken: opts?.deviceToken,
      },
    );
    try {
      return {
        ok: true,
        grantedScopes: hello.grantedScopes,
        connId: hello.connId,
        pairedRequestId,
        deviceToken: hello.deviceToken,
      };
    } finally {
      await client.close();
    }
  } catch (err) {
    if (err instanceof OpenClawError) {
      return { ok: false, error: err.code, reason: err.detail?.reason };
    }
    return {
      ok: false,
      error: "gateway_invalid_response",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
