// @occa/gateway-claude-code — library surface.
//
// Most hosts run the gateway as a service via the `occa-claude-gateway` bin
// (see ./bin). This entry exposes the same pieces for programmatic use and,
// crucially, re-exports the wire-protocol types so an HTTP client (OCCA's
// claude-code adapter) shares one contract with the server. Clients should
// `import type` from "@occa/gateway-claude-code/wire" to stay runtime-free.

export { startGateway } from "./server";
export { loadConfig, type GatewayConfig } from "./config";
export { workspacePathFor } from "./workspace";
export {
  runClaude,
  claudeAvailable,
  probeClaude,
  sessionUuidFromKey,
} from "./claude-cli";
export type {
  ClaudeStreamEvent,
  RunClaudeInput,
  RunClaudeResult,
} from "./wire";
