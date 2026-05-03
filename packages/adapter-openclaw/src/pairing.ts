import { OpenClawClient, OpenClawError } from "./client";
import type { DeviceIdentity } from "./keypair";

export interface PairingResult {
  ok: boolean;
  requestId?: string;
  reason?: string;
}

interface PendingEntry {
  requestId?: string;
  deviceId?: string;
  createdAt?: number | string;
}

export async function autoApproveDevicePairing(params: {
  gatewayUrl: string;
  apiKey: string;
  device: DeviceIdentity;
  pairingRequestId?: string;
  handshakeTimeoutMs?: number;
}): Promise<PairingResult> {
  if (!params.apiKey) {
    return { ok: false, reason: "api_key_missing" };
  }

  const client = new OpenClawClient({
    gatewayUrl: params.gatewayUrl,
    apiKey: params.apiKey,
    device: params.device,
    scopes: ["operator.pairing"],
    handshakeTimeoutMs: params.handshakeTimeoutMs,
  });

  try {
    try {
      await client.connect();
    } catch (err) {
      if (err instanceof OpenClawError) {
        return { ok: false, reason: `pairing_scope_denied:${err.code}` };
      }
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    let requestId = params.pairingRequestId;
    if (!requestId) {
      try {
        const listed = (await client.sendRpc("device.pair.list", {})) as
          | { pending?: PendingEntry[]; requests?: PendingEntry[] }
          | PendingEntry[]
          | undefined;
        const entries: PendingEntry[] = Array.isArray(listed)
          ? listed
          : (listed?.pending ?? listed?.requests ?? []);
        const forThisDevice = entries.find(
          (e) => e.deviceId === params.device.deviceId,
        );
        requestId = (forThisDevice ?? entries[entries.length - 1])?.requestId;
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : "list_failed",
        };
      }
    }

    if (!requestId) {
      return { ok: false, reason: "no_pending_request" };
    }

    try {
      await client.sendRpc("device.pair.approve", { requestId });
      return { ok: true, requestId };
    } catch (err) {
      return {
        ok: false,
        requestId,
        reason: err instanceof Error ? err.message : "approve_failed",
      };
    }
  } finally {
    await client.close();
  }
}
