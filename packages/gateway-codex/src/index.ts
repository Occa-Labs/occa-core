// @occa/gateway-codex — library surface.
//
// Most hosts run the gateway as a service via the `occa-codex-gateway` bin
// (see ./bin). This entry exposes the same pieces for programmatic use and
// re-exports the wire-protocol types so an HTTP client (OCCA's codex adapter)
// shares one contract with the server. Clients should `import type` from
// "@occa/gateway-codex/wire" to stay runtime-free.

export { startGateway } from "./server";
export { loadConfig, type GatewayConfig } from "./config";
export { workspacePathFor } from "./workspace";
export { runCodex, codexAvailable } from "./codex-cli";
export type {
  CodexStreamEvent,
  RunCodexInput,
  RunCodexResult,
} from "./wire";
