// Catalog entry schema — validates the YAML files under
// `apps/server/src/features/tools/catalog/`. The catalog is data, not
// code: each YAML describes one tool the operator can install. The
// `implementation` block tells the invoke service how to actually run
// the tool's actions:
//
//   - kind: "embedded"  → routes to an in-process handler under
//     `handlers/<handler-name>.ts`. Used for tools where OCCA bundles
//     the implementation (e.g. X with OAuth 1.0a, before its MCP
//     server lands).
//
//   - kind: "mcp"        → routes to an external MCP server. The server
//     URL is either fixed in the catalog (curated public MCP) or
//     supplied at install time via the tool's metadata field (custom
//     escape hatch).
//
// Catalog entries with `kind: "mcp"` and `url: "dynamic"` flag that the
// install UI must collect the server URL from the operator.

import { z } from "zod";

export const fieldHintSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["string", "number", "boolean"]).default("string"),
  required: z.boolean().default(true),
  secret: z.boolean().default(false),
  description: z.string().optional(),
});

export const actionSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

const embeddedImplSchema = z.object({
  kind: z.literal("embedded"),
  handler: z.string().min(1), // matches a registered in-process handler
});

const mcpImplSchema = z.object({
  kind: z.literal("mcp"),
  transport: z.enum(["http", "stdio"]).default("http"),
  // The MCP server URL. `"dynamic"` means it's supplied per-install
  // through the tool's metadata `url` field — used by the custom-MCP
  // escape hatch.
  url: z.string(),
  // Optional name of the metadata field that holds the URL when
  // `url === "dynamic"`. Defaults to `url`.
  urlMetadataField: z.string().optional(),
});

export const implementationSchema = z.discriminatedUnion("kind", [
  embeddedImplSchema,
  mcpImplSchema,
]);

export const catalogEntrySchema = z.object({
  type: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "type must be lowercase, kebab-case, alphanumeric",
    ),
  displayName: z.string().min(1),
  description: z.string().min(1),
  implementation: implementationSchema,
  credentialFields: z.array(fieldHintSchema).default([]),
  metadataFields: z.array(fieldHintSchema).default([]),
  // Static actions list. Empty when actions resolve dynamically from
  // the MCP server (or any other dynamic source).
  actions: z.array(actionSpecSchema).default([]),
  // True when this catalog entry's actions are not enumerable until the
  // tool is installed (MCP introspection at runtime).
  hasDynamicActions: z.boolean().default(false),
  // True when the operator can run a connection test from the install
  // UI. Only meaningful for embedded handlers that expose testConnection
  // (MCP transports get connectivity verification via a generic ping).
  hasTestConnection: z.boolean().default(false),
});

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
export type CatalogImplementation = z.infer<typeof implementationSchema>;
