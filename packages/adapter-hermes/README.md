# @occa/adapter-hermes

OCCA runtime adapter for [Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research.

Talks to a remote Hermes VPS via its OpenAI-compatible HTTP gateway (`hermes gateway` with `API_SERVER_ENABLED=true`). OCCA holds a public HTTPS URL + bearer token and drives `/v1/chat/completions`, `/v1/responses`, and `/v1/runs` per agent turn. OCCA owns memory and orchestration; Hermes runs the agent loop.

This is the second adapter in OCCA's BYORT (Bring Your Own Runtime) line, alongside [`@occa/adapter-openclaw`](../adapter-openclaw/README.md). It closes the runtime side of whitepaper §14.1's "two live adapters before Phase 2" gate.

## Architecture

```
OCCA dispatcher (server or worker)
  -> adapter.sendPrompt / executeTrace
       -> HTTPS POST <gatewayUrl>/v1/chat/completions
            Authorization: Bearer <apiKey>
            -> Hermes API server (gateway/platforms/api_server.py)
                 -> Hermes conversation loop (AIAgent)
                      -> provider (OpenRouter / Nous Portal / etc.)
                      -> tools (terminal, files, MCP servers configured VPS-side)
            <- streamed response (OpenAI-format chunks)
       <- AdapterTraceResult / AdapterSendPromptResult
```

Hermes-specific concepts (the API server platform, profiles, Nous Portal OAuth, VPS-side `config.yaml`) are confined to this package. OCCA's server and worker call the adapter only through the `AgentAdapter` contract from [`@occa/runtime-core`](../runtime-core).

## Install

```sh
pnpm add @occa/adapter-hermes
```

Workspace-internal in the OCCA monorepo:

```jsonc
// package.json
{
  "dependencies": {
    "@occa/adapter-hermes": "workspace:*"
  }
}
```

## Quick start

```ts
import { hermesAdapter } from "@occa/adapter-hermes";

const config = {
  gatewayUrl: "https://hermes.example.com",
  apiKey: "<API_SERVER_KEY from ~/.hermes/.env on the VPS>",
};

const probe = await hermesAdapter.probeConnection(config);
if (!probe.ok) throw new Error(probe.error);
```

## Configuration shape

```ts
interface HermesAdapterConfig {
  /** Public HTTPS URL of the Hermes API server, e.g. "https://hermes.occa.team". */
  gatewayUrl: string;
  /** API_SERVER_KEY bearer token configured on the VPS. */
  apiKey: string;
}
```

## AgentAdapter methods

| Method | Status | Notes |
|---|---|---|
| `probeConnection` | implemented | `GET <gatewayUrl>/v1/capabilities` with bearer; returns latency + advertised platform. |
| `prepareCredentials` | no-op | Single bearer auth; no per-agent credential minting at this layer. |
| `provision` | no-op | API server is already running on the VPS; echoes `desiredExternalId` back. |
| `deprovision` | no-op | Nothing to clean up on the remote side. |
| `seedWorkspace` | no-op | OCCA renders the full system prompt + context per request; workspace files live in OCCA's DB. |
| `sendPrompt` | not implemented | Phase 4b → `POST /v1/chat/completions` (stateless). |
| `executeTrace` | not implemented | Phase 4b → `POST /v1/runs` for SSE progress + action-block parsing. |
| `resetSession` | no-op | Hermes session state is per-request when OCCA uses the stateless endpoint. |

## VPS bootstrap

Tested against Ubuntu 24.04, Hermes Agent v0.14.0, Python 3.11, on an AWS EC2 box (`hermes.occa.team`).

```sh
# 1. Install Hermes
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash

# 2. Enable the API server (~/.hermes/.env)
cat >> ~/.hermes/.env <<EOF
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
API_SERVER_KEY=$(openssl rand -hex 32)
EOF

# 3. Install hermes-gateway as a systemd service (auto-starts the API server)
sudo /home/ubuntu/.local/bin/hermes gateway install --system --run-as-user ubuntu

# 4. Front the loopback port with a TLS terminator (Caddy example)
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
hermes.example.com {
  reverse_proxy localhost:8642
}
EOF
sudo systemctl restart caddy

# 5. Verify from outside
curl https://hermes.example.com/v1/capabilities \
  -H "Authorization: Bearer <bearer>"
```

The Hermes API server is part of the `hermes gateway` process (`gateway/platforms/api_server.py`). Setting `API_SERVER_ENABLED=true` adds the API server as one of the gateway's platforms; the other messaging platforms (Telegram, Discord, etc.) stay dormant unless configured.

## License

MIT
