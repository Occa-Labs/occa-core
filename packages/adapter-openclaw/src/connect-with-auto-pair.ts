import { OpenClawClient, OpenClawError, type HelloOk } from "./client";
import type { DeviceIdentity } from "./keypair";
import { autoApproveDevicePairing } from "./pairing";

export interface ConnectWithAutoPairResult {
  client: OpenClawClient;
  hello: HelloOk;
  pairedRequestId?: string;
}

export async function connectWithAutoPair(
  config: { gatewayUrl: string; apiKey: string },
  device: DeviceIdentity,
  opts?: {
    handshakeTimeoutMs?: number;
    scopes?: string[];
    onEvent?: (evt: { event: string; payload: unknown }) => void;
    deviceToken?: string;
  },
): Promise<ConnectWithAutoPairResult> {
  const client = new OpenClawClient({
    gatewayUrl: config.gatewayUrl,
    apiKey: config.apiKey,
    device,
    scopes: opts?.scopes,
    handshakeTimeoutMs: opts?.handshakeTimeoutMs,
    onEvent: opts?.onEvent,
    deviceToken: opts?.deviceToken,
  });

  try {
    const hello = await client.connect();
    return { client, hello };
  } catch (err) {
    await client.close();
    if (!(err instanceof OpenClawError) || err.code !== "device_pairing_required") {
      throw err;
    }
    console.log(
      `[adapter-openclaw] device_pairing_required requestId=${err.detail?.requestId ?? "n/a"} — attempting auto-approve`,
    );

    const pair = await autoApproveDevicePairing({
      gatewayUrl: config.gatewayUrl,
      apiKey: config.apiKey,
      device,
      pairingRequestId: err.detail?.requestId,
      handshakeTimeoutMs: opts?.handshakeTimeoutMs,
    });
    if (!pair.ok) {
      console.warn(
        `[adapter-openclaw] auto-pair failed: reason=${pair.reason ?? "unknown"}`,
      );
      throw new OpenClawError("device_pairing_required", {
        reason: pair.reason ?? "auto_pair_failed",
      });
    }
    console.log(
      `[adapter-openclaw] auto-pair ok requestId=${pair.requestId} — retrying connect`,
    );

    const retry = new OpenClawClient({
      gatewayUrl: config.gatewayUrl,
      apiKey: config.apiKey,
      device,
      scopes: opts?.scopes,
      handshakeTimeoutMs: opts?.handshakeTimeoutMs,
      onEvent: opts?.onEvent,
      deviceToken: opts?.deviceToken,
    });
    try {
      const hello = await retry.connect();
      return { client: retry, hello, pairedRequestId: pair.requestId };
    } catch (retryErr) {
      await retry.close();
      throw retryErr;
    }
  }
}
