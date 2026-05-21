// Build a Zod schema from a catalog entry's `credentialFields` /
// `metadataFields` declarations. Used at install + patch time to validate
// the operator's submitted values before encryption.
//
// For embedded-backed catalog entries the embedded handler also ships a
// more precise Zod schema (`credentialsSchema`) — when present, prefer
// that one. Field-hint-derived schemas are looser (no min/max, no
// regex) but they're the only source of truth for MCP-backed entries.

import { z } from "zod";
import type { ZodSchema } from "zod";
import type { CatalogEntry } from "../domain/catalog-schemas";
import type { ToolFieldHint } from "../domain/types";
import { findEmbeddedHandler } from "../handlers/embedded-handlers";

export function buildSchemaFromFieldHints(
  fields: ToolFieldHint[],
): ZodSchema {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    let base: z.ZodTypeAny;
    if (field.type === "number") base = z.number();
    else if (field.type === "boolean") base = z.boolean();
    else base = z.string();
    if (!field.required) base = base.optional();
    shape[field.name] = base;
  }
  return z.object(shape);
}

export function credentialsSchemaFor(entry: CatalogEntry): ZodSchema {
  if (entry.implementation.kind === "embedded") {
    const handler = findEmbeddedHandler(entry.implementation.handler);
    if (handler) return handler.credentialsSchema;
  }
  return buildSchemaFromFieldHints(entry.credentialFields);
}

export function metadataSchemaFor(entry: CatalogEntry): ZodSchema {
  return buildSchemaFromFieldHints(entry.metadataFields);
}
