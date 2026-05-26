# @occa/adapter-openclaw

OCCA runtime adapter for [OpenClaw](https://openclaw.com) by Peter Steinberger.

Connects an OCCA-managed agent identity to a self-hosted OpenClaw gateway, using its protocol-v3 WebSocket transport and Ed25519 device authentication. The OpenClaw runtime executes the agent loop; OCCA owns identity, context, treasury, and orchestration.

This is the first BYORT (Bring Your Own Runtime) adapter OCCA shipped. The sibling adapter [`@occa/adapter-hermes`](../adapter-hermes/README.md) covers the Nous Research Hermes Agent runtime.

## Architecture

```
OCCA dispatcher (server or worker)
  -> adapter.sendPrompt / executeTrace
       -> WebSocket: wss://gateway.example.com (TLS via Caddy + LE)
            -> OpenClaw protocol-v3 frames
                 -> device.pair.* / agent.* / chat.* / workspace.*
                 -> Ed25519-signed each request
                 -> hooksToken-scoped session
            <- agent reply, action blocks, hook events
       <- AdapterTraceResult / AdapterSendPromptResult
```

OpenClaw-specific concepts (`openclawAgentId`, `hooksToken`, `sessionKey`, `protocol-v3`, the Ed25519 device pairing flow) are confined to this package. OCCA's server and worker call the adapter only through the `AgentAdapter` contract from [`@occa/runtime-core`](../runtime-core).

## Install

```sh
pnpm add @occa/adapter-openclaw
```

Workspace-internal in the OCCA monorepo:

```jsonc
// package.json
{
  "dependencies": {
    "@occa/adapter-openclaw": "workspace:*"
  }
}
```

## Quick start

```ts
import { openclawAdapter } from "@occa/adapter-openclaw";

const config = {
  gatewayUrl: "wss://gateway.example.com",
  apiKey: "<bearer-token-from-openclaw.json>",
};

const probe = await openclawAdapter.probeConnection(config);
console.log(probe); // { ok: true, latencyMs: ..., info: { ... } }

const result = await openclawAdapter.sendPrompt({
  adapterConfig: { ...config, deviceKeypair, deviceToken, openclawAgentId },
  externalAgentId: openclawAgentId,
  sessionKey: "agent:123:trace:abc",
  message: "List my open tasks and pick the highest priority one.",
});

if (result.ok) console.log(result.reply);
```

## Configuration shape

The adapter accepts a free-form `adapterConfig` object (declared as `Record<string, unknown>` to satisfy the cross-adapter contract), with this OpenClaw-specific shape:

| Field | Type | Source |
|---|---|---|
| `gatewayUrl` | `string` | OpenClaw gateway WS URL, e.g. `wss://gateway.example.com` |
| `apiKey` | `string` | Bearer token from the gateway's `~/.openclaw/openclaw.json` |
| `deviceKeypair` | `SerializedKeypair` | Generated on first `prepareCredentials`; persisted in `agents.adapter_config` |
| `deviceToken` | `string` (optional) | Issued by the gateway during pairing; reused on subsequent connects |
| `openclawAgentId` | `string` | Populated by `provision` after the agent is created gateway-side |
| `workspacePath` | `string` | Workspace root the agent operates within, also set during `provision` |

`SerializedKeypair` is `{ deviceId, publicKey, privateKeyHex }`, all strings. The keypair is re-used across probes so the gateway doesn't generate a new pending-pair request on every background tick.

## AgentAdapter methods

| Method | Notes |
|---|---|
| `probeConnection` | WebSocket connect + auth check. Reuses persisted device identity + token where available to avoid forcing repeated user approvals. |
| `prepareCredentials` | Generates an ephemeral Ed25519 keypair if none is supplied, validates against the gateway (`validateDeviceKeypair`), returns `configPatch` with `deviceKeypair` and `deviceToken`. Can reuse a passed-in keypair when an existing agent shares identity (kickoff service, sibling agent provisioning). |
| `provision` | Calls `provisionAgent` to create the agent on the gateway side. Returns `externalAgentId` (the `openclawAgentId`) and the resolved `workspacePath`. |
| `deprovision` | Best-effort `deprovisionAgent`. Skipped silently if config is incomplete. |
| `seedWorkspace` | Pushes `{ filename, content }[]` to the gateway-side workspace via the OpenClaw RPC. |
| `sendPrompt` | Single-turn HTTP-style invocation used by the server task dispatcher. Streams chunks back via the optional `onEvent` callback. |
| `executeTrace` | Full wake/trace cycle used by the worker dispatcher. Renders wake context, runs the conversation loop, parses `[[OCCA:DELEGATE]]` / `[[OCCA:BLOCK]]` / `[[OCCA:FINISH]]` action blocks, returns `AdapterTraceResult`. |
| `resetSession` | Wipes the gateway-side conversation memory for a `sessionKey`. Used when the user clears a chat thread. |

Public re-exports for advanced callers: `probeConnection`, `executeTrace`, `validateDeviceKeypair`, `provisionAgent`, `deprovisionAgent`, `listGatewayAgents`, `seedWorkspace`, `deleteAgentSession`, `sendAgentPrompt`, `chatWithAgent`, `fireAgentPrompt`, `checkAgentRun`, `generateEphemeralKeypair`, `serializeKeypair`, `deserializeKeypair`.

## OpenClaw gateway requirements

The gateway runs as a user-mode systemd service via `systemd-linger`. The OCCA project hosts its reference deployment on AWS EC2 (`t3.medium`, Ubuntu 24.04), fronted by Caddy with Let's Encrypt TLS:

```
gateway.example.com {
    reverse_proxy localhost:18789
}
```

Where 18789 is the OpenClaw gateway loopback port (`gateway.port` in `~/.openclaw/openclaw.json`).

Refer to the upstream OpenClaw project for full setup details. The adapter assumes a reachable `wss://` endpoint and a valid bearer token from the operator's `openclaw.json`.

## Status

Production. All `AgentAdapter` methods are implemented end-to-end. Registered in both OCCA adapter registries (`apps/server`, `apps/worker`).

## License

MIT
