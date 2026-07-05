# @occa/gateway-codex

[![npm](https://img.shields.io/npm/v/@occa/gateway-codex.svg)](https://www.npmjs.com/package/@occa/gateway-codex)
[![license](https://img.shields.io/npm/l/@occa/gateway-codex.svg)](./LICENSE)

A thin HTTP service that wraps the [`codex`](https://developers.openai.com/codex) CLI so OCCA can run Codex agents on a box it does **not** own (BYORT — "bring your own runtime").

The box owner installs `codex`, authenticates it once, and runs this gateway with a shared bearer. OCCA's codex adapter then talks to it over HTTP — the same shape as the OpenClaw, Hermes, and Claude gateways. The gateway is OCCA-agnostic: it knows nothing about deployments, tasks, or markers. It writes the files it is handed and runs the prompt it is given.

## Requirements

- Node.js ≥ 18
- The [`codex`](https://developers.openai.com/codex) CLI, authenticated (a ChatGPT plan via `codex login`, or an `OPENAI_API_KEY`)

## Quickstart

```bash
# 1. Install + authenticate the Codex CLI.
npm i -g @openai/codex
codex login

# 2. Install the gateway (or skip and use `npx @occa/gateway-codex`).
npm i -g @occa/gateway-codex

# 3. Set a shared bearer once, confirm the box is ready, then run.
occa-codex-gateway config set token <shared-bearer>
occa-codex-gateway doctor
occa-codex-gateway
```

The bearer is the only shared secret — it goes into the OCCA deployment's `adapterConfig.apiKey`. A liveness probe without it returns `401` (which still proves the service is up).

## CLI

```
occa-codex-gateway [command] [options]

Commands:
  start            Start the gateway (default when no command is given)
  doctor           Check the codex CLI and print the resolved config

Options:
  -t, --token <bearer>      Shared bearer clients must send   [env CODEX_GATEWAY_TOKEN]
  -p, --port <number>       Listen port (default 8719)         [env CODEX_GATEWAY_PORT]
  -H, --host <address>      Bind address (default all)         [env CODEX_GATEWAY_HOST]
      --tls-cert <path>     PEM cert — serve HTTPS (needs --tls-key)
      --tls-key <path>      PEM private key — serve HTTPS (needs --tls-cert)
      --workspace <dir>     Per-agent workspace root           [env OCCA_CODEX_WORKSPACE_ROOT]
      --no-banner           Don't print the startup splash
      --banner              Print the splash and exit
  -h, --help                Show help
  -v, --version             Show version
```

Flags override the environment, which overrides the stored config file, so `--port 9000` beats a stale `CODEX_GATEWAY_PORT`. Persist settings once with `config set` instead of passing flags every run:

```bash
occa-codex-gateway config set token <shared-bearer>
occa-codex-gateway doctor      # codex ok? token set? scheme? prints resolved config
occa-codex-gateway             # uses the stored config
```

### HTTPS

By default the gateway serves plain HTTP — bind it to loopback (`--host 127.0.0.1`) and front it with a TLS-terminating reverse proxy (Caddy, nginx). To terminate TLS in the gateway itself, give it a PEM cert + key:

```bash
occa-codex-gateway --tls-cert ./cert.pem --tls-key ./key.pem
# or persist them:
occa-codex-gateway config set tls-cert /etc/occa/cert.pem
occa-codex-gateway config set tls-key  /etc/occa/key.pem
```

## Configuration (environment)

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `CODEX_GATEWAY_TOKEN` | yes | — | Shared bearer. OCCA sends it as `Authorization: Bearer <token>`. |
| `CODEX_GATEWAY_PORT` | no | `8719` | Listen port. |
| `CODEX_GATEWAY_HOST` | no | dual-stack all interfaces | Set `127.0.0.1` to restrict to loopback (front with a reverse proxy). |
| `CODEX_GATEWAY_TLS_CERT` | no | — | PEM cert path. With `…TLS_KEY`, the gateway serves HTTPS. |
| `CODEX_GATEWAY_TLS_KEY` | no | — | PEM private-key path. Required alongside `…TLS_CERT`. |
| `OPENAI_API_KEY` | for headless | — | Codex model auth (or a `codex login` session in `~/.codex/auth.json`). The gateway never reads it directly; `codex` does. |
| `OCCA_CODEX_BIN` | no | `codex` | Path to the `codex` binary if not on `PATH`. |
| `OCCA_CODEX_WORKSPACE_ROOT` | no | `~/.occa-codex-agents` | Root dir for per-agent workspaces. |

## Endpoints

All require `Authorization: Bearer <CODEX_GATEWAY_TOKEN>`.

- `GET  /v1/health` — probe the codex binary, returns `{ ok, ... }`
- `POST /v1/seed` — write workspace files (e.g. `AGENTS.md`) for an agent
- `POST /v1/run` — run one turn, stream NDJSON events + a trailing result line
- `POST /v1/cancel` — explicitly cancel an in-flight run
- `POST /v1/deprovision` — remove an agent's workspace

A run is decoupled from the HTTP connection that started it: a client whose stream drops mid-run can re-POST `/v1/run` with the same `sessionKey` + a `resumeCursor` and resume from where it left off.

### Session continuity

Codex has no flag to set a session id, so the gateway captures the `thread_id` codex emits on the first turn, persists a `sessionKey → thread_id` map in the agent's workspace, and resumes later turns with `codex exec resume <thread_id>`. A stale id (rollout gone) transparently falls back to a fresh thread.

## Programmatic use

```ts
import { startGateway, loadConfig } from "@occa/gateway-codex";

startGateway(loadConfig());
```

HTTP clients should import the wire-protocol types (the shared contract) without pulling in the server runtime:

```ts
import type { CodexStreamEvent, RunCodexResult } from "@occa/gateway-codex/wire";
```

## systemd

```ini
[Unit]
Description=OCCA Codex Gateway
After=network.target

[Service]
Environment=CODEX_GATEWAY_TOKEN=<shared-bearer>
Environment=OPENAI_API_KEY=<openai-key>
Environment=CODEX_GATEWAY_HOST=127.0.0.1
ExecStart=/usr/bin/occa-codex-gateway
Restart=always

[Install]
WantedBy=multi-user.target
```

## License

MIT
