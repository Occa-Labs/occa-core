# @occa/gateway-claude-code

A thin HTTP service that wraps the [`claude`](https://docs.claude.com/en/docs/claude-code) CLI so OCCA can run Claude Code agents on a box it does **not** own (BYORT — "bring your own runtime").

The box owner installs `claude`, authenticates it once, and runs this gateway with a shared bearer. OCCA's claude-code adapter then talks to it over HTTP — the same shape as the OpenClaw and Hermes gateways. The gateway is OCCA-agnostic: it knows nothing about deployments, tasks, or markers. It writes the files it is handed and runs the prompt it is given.

## Install & run

```bash
# 1. Install the Claude Code CLI and authenticate (Pro/Max subscription).
npm i -g @anthropic-ai/claude-code
claude setup-token   # writes CLAUDE_CODE_OAUTH_TOKEN-style credentials

# 2. Run the gateway.
CLAUDE_GATEWAY_TOKEN=<shared-bearer> npx @occa/gateway-claude-code
```

A liveness probe without the bearer returns `401` (proves the service is up).

## CLI

```
occa-claude-gateway [command] [options]

Commands:
  start            Start the gateway (default when no command is given)
  doctor           Check the claude CLI + auth and print the resolved config

Options:
  -t, --token <bearer>      Shared bearer clients must send   [env CLAUDE_GATEWAY_TOKEN]
  -p, --port <number>       Listen port (default 8718)         [env CLAUDE_GATEWAY_PORT]
  -H, --host <address>      Bind address (default all)         [env CLAUDE_GATEWAY_HOST]
      --tls-cert <path>     PEM cert — serve HTTPS (needs --tls-key)
      --tls-key <path>      PEM private key — serve HTTPS (needs --tls-cert)
      --health-model <name> Health-probe model (default sonnet)
      --workspace <dir>     Per-agent workspace root           [env OCCA_CLAUDE_WORKSPACE_ROOT]
      --no-banner           Don't print the startup splash
      --banner              Print the splash and exit
  -h, --help                Show help
  -v, --version             Show version
```

Flags override the environment, which overrides the stored config file, so `--port 9000` beats a stale `CLAUDE_GATEWAY_PORT`. Persist settings once with `config set` instead of passing flags every run:

```bash
occa-claude-gateway config set token <shared-bearer>
occa-claude-gateway doctor      # claude ok? token set? scheme? prints resolved config
occa-claude-gateway             # uses the stored config
```

### HTTPS

By default the gateway serves plain HTTP — bind it to loopback (`--host 127.0.0.1`) and front it with a TLS-terminating reverse proxy (Caddy, nginx). To terminate TLS in the gateway itself, give it a PEM cert + key:

```bash
occa-claude-gateway --tls-cert ./cert.pem --tls-key ./key.pem
# or persist them:
occa-claude-gateway config set tls-cert /etc/occa/cert.pem
occa-claude-gateway config set tls-key  /etc/occa/key.pem
```

## Configuration (environment)

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `CLAUDE_GATEWAY_TOKEN` | yes | — | Shared bearer. OCCA sends it as `Authorization: Bearer <token>`. |
| `CLAUDE_GATEWAY_PORT` | no | `8718` | Listen port. |
| `CLAUDE_GATEWAY_HOST` | no | dual-stack all interfaces | Set `127.0.0.1` to restrict to loopback (front with a reverse proxy). |
| `CLAUDE_GATEWAY_TLS_CERT` | no | — | PEM cert path. With `…TLS_KEY`, the gateway serves HTTPS. |
| `CLAUDE_GATEWAY_TLS_KEY` | no | — | PEM private-key path. Required alongside `…TLS_CERT`. |
| `CLAUDE_GATEWAY_HEALTH_MODEL` | no | `sonnet` | Model alias used by the health probe. |
| `CLAUDE_CODE_OAUTH_TOKEN` | for headless | — | Subscription token from `claude setup-token`. The gateway never reads it directly; `claude` does. |
| `OCCA_CLAUDE_BIN` | no | `claude` | Path to the `claude` binary if not on `PATH`. |
| `OCCA_CLAUDE_WORKSPACE_ROOT` | no | `~/.occa-claude-agents` | Root dir for per-agent workspaces. |

## Endpoints

All require `Authorization: Bearer <CLAUDE_GATEWAY_TOKEN>`.

- `GET  /v1/health` — probe claude + auth, returns `{ ok, ... }`
- `POST /v1/seed` — write workspace files for an agent
- `POST /v1/run` — run one turn, stream NDJSON events + a trailing result line
- `POST /v1/cancel` — explicitly cancel an in-flight run
- `POST /v1/deprovision` — remove an agent's workspace

A run is decoupled from the HTTP connection that started it: a client whose stream drops mid-run can re-POST `/v1/run` with the same `sessionKey` + a `resumeCursor` and resume from where it left off.

## Programmatic use

```ts
import { startGateway, loadConfig } from "@occa/gateway-claude-code";

startGateway(loadConfig());
```

HTTP clients should import the wire-protocol types (the shared contract) without pulling in the server runtime:

```ts
import type { ClaudeStreamEvent, RunClaudeResult } from "@occa/gateway-claude-code/wire";
```

## systemd

```ini
[Unit]
Description=OCCA Claude Gateway
After=network.target

[Service]
Environment=CLAUDE_GATEWAY_TOKEN=<shared-bearer>
Environment=CLAUDE_CODE_OAUTH_TOKEN=<subscription-token>
Environment=CLAUDE_GATEWAY_HOST=127.0.0.1
ExecStart=/usr/bin/occa-claude-gateway
Restart=always

[Install]
WantedBy=multi-user.target
```

## License

MIT
