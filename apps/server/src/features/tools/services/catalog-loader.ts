// Catalog loader — reads `apps/server/src/features/tools/catalog/*.yaml`
// at module load and exposes typed lookups.
//
// Each YAML file is one tool entry the operator can install. The catalog
// is the source of truth for what's installable; the in-process handler
// registry (handlers/*.ts) only provides backend implementations that
// catalog entries with `implementation.kind === "embedded"` can target.
//
// Adding a new tool means dropping a new YAML in the catalog folder
// (plus, if it's a brand-new auth pattern that doesn't have a community
// MCP server yet, an embedded handler). The OCCA team does not write
// per-tool TypeScript when an MCP-backed entry suffices.

import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  catalogEntrySchema,
  type CatalogEntry,
} from "../domain/catalog-schemas";

const CATALOG_DIR = path.resolve(__dirname, "../catalog");

let cache: CatalogEntry[] | null = null;
let cacheByType: Map<string, CatalogEntry> | null = null;

async function loadFromDisk(): Promise<CatalogEntry[]> {
  const files = await fs.readdir(CATALOG_DIR);
  const entries: CatalogEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const fullPath = path.join(CATALOG_DIR, file);
    const raw = await fs.readFile(fullPath, "utf8");
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      throw new Error(
        `catalog loader: ${file} is not valid YAML — ${
          err instanceof Error ? err.message : "parse failed"
        }`,
      );
    }
    const result = catalogEntrySchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `catalog loader: ${file} failed schema validation: ${JSON.stringify(
          result.error.flatten(),
        )}`,
      );
    }
    entries.push(result.data);
  }

  // Guard against accidental dup-type catalog files.
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.type)) {
      throw new Error(
        `catalog loader: duplicate type "${e.type}" across YAML files`,
      );
    }
    seen.add(e.type);
  }

  return entries.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

async function ensureLoaded(): Promise<void> {
  if (cache !== null) return;
  const entries = await loadFromDisk();
  cache = entries;
  cacheByType = new Map(entries.map((e) => [e.type, e]));
}

export async function listCatalog(): Promise<CatalogEntry[]> {
  await ensureLoaded();
  return cache!;
}

export async function findCatalogEntry(
  type: string,
): Promise<CatalogEntry | null> {
  await ensureLoaded();
  return cacheByType!.get(type) ?? null;
}

// Test-only: clear the in-memory cache so the next read re-reads disk.
// Production paths never call this; it exists for hot-reload during dev
// and for the smoke test that adds a temp catalog file.
export function _resetCatalogCache(): void {
  cache = null;
  cacheByType = null;
}
