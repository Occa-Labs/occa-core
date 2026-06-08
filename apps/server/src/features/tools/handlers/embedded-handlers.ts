// Embedded handlers — in-process implementations that the catalog can
// route to via `implementation: { kind: "embedded", handler: <name> }`.
//
// This map is the only OCCA-code surface that defines per-tool actions.
// Catalog entries that route to "mcp" don't need anything here; their
// actions live on the MCP server.
//
// The map intentionally stays small. New tools should prefer MCP
// servers; embedded handlers are reserved for cases where:
//
//   - A standardized MCP server doesn't exist yet, AND
//   - The auth/signing flow is non-trivial enough to justify shipping
//     it inside OCCA (e.g. OAuth 1.0a HMAC-SHA1 with strict signing
//     base string for X)
//
// When an external MCP equivalent matures, flip the catalog entry's
// `implementation` and drop the embedded handler.

import { publishHandler } from "./publish";
import { xHandler } from "./x";
import type { ToolHandler } from "../domain/types";

export const EMBEDDED_HANDLERS: Map<string, ToolHandler> = new Map([
  ["x", xHandler],
  ["publish", publishHandler],
]);

export function findEmbeddedHandler(name: string): ToolHandler | null {
  return EMBEDDED_HANDLERS.get(name) ?? null;
}
