import type { OpenClawProbeResult } from "@occa/runtime-core";
import { OpenClawClient, OpenClawError } from "./client";
import { connectWithAutoPair } from "./connect-with-auto-pair";
import { generateEphemeralKeypair, type DeviceIdentity } from "./keypair";

export async function probeConnection(
  config: { gatewayUrl: string; apiKey: string },
  opts?: {
    timeoutMs?: number;
    device?: DeviceIdentity;
    /**
     * Previously-issued device token. Replayed in the connect frame so the
     * gateway resolves the existing pair instead of re-prompting for approval.
     */
    deviceToken?: string;
  },
): Promise<OpenClawProbeResult> {
  const device = opts?.device ?? (await generateEphemeralKeypair());
  console.log(
    `[adapter-openclaw] probe: connecting ${config.gatewayUrl} (device=${device.deviceId.slice(0, 12)}… ${opts?.deviceToken ? "with-token" : "no-token"})`,
  );
  const start = performance.now();
  let client: OpenClawClient | null = null;
  try {
    const res = await connectWithAutoPair(config, device, {
      handshakeTimeoutMs: opts?.timeoutMs ?? 10_000,
      deviceToken: opts?.deviceToken,
    });
    client = res.client;
    const latencyMs = Math.round(performance.now() - start);
    console.log(
      `[adapter-openclaw] probe: hello-ok scopes=[${res.hello.grantedScopes.join(",")}] latency=${latencyMs}ms ${res.hello.deviceToken ? "token-issued" : "token-absent"}`,
    );
    return {
      ok: true,
      latencyMs,
      info: {
        scopes: res.hello.grantedScopes,
        connId: res.hello.connId ?? undefined,
        protocol: res.hello.protocol,
        deviceToken: res.hello.deviceToken,
      },
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    if (err instanceof OpenClawError) {
      console.warn(
        `[adapter-openclaw] probe: failed code=${err.code} reason="${err.detail?.reason ?? ""}"`,
      );
      return { ok: false, latencyMs, error: mapProbeError(err.code) };
    }
    console.warn(
      `[adapter-openclaw] probe: non-adapter error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, latencyMs, error: "invalid_response" };
  } finally {
    if (client) await client.close();
  }
}

function mapProbeError(
  code: OpenClawError["code"],
): OpenClawProbeResult["error"] {
  switch (code) {
    case "gateway_unreachable":
    case "gateway_handshake_timeout":
      return "unreachable";
    case "device_pairing_required":
      return "pairing_required";
    case "gateway_unauthorized":
      return "unauthorized";
    default:
      return "invalid_response";
  }
}
