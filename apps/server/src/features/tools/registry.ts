// Deprecated. The Tools primitive is now catalog-driven (YAML files
// under `apps/server/src/features/tools/catalog/`). In-process handlers
// for catalog entries with `implementation.kind === "embedded"` live in
// `handlers/embedded-handlers.ts`.
//
// This file is kept as a stub so old imports surface a clear compile
// error and to give us a single grep target during the transition.

export const REGISTRY_REMOVED =
  "tools/registry was removed. Use services/catalog-loader (catalog data) plus handlers/embedded-handlers (in-process handler dispatch).";
