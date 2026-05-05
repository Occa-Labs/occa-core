import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { childLogger } from "../../lib/logger";
import { PG_ERROR_CODES } from "../../lib/pg-errors";

const log = childLogger("db:schema");

// Known-applied sentinel. If `public.users` is present the migrations have
// already committed at least once, so a 42P07 during a re-run means "tables
// already exist, just stamp the journal". If the sentinel is missing, 42P07
// is a genuine error — the migration chain is broken and we must not claim
// success.
const APP_SENTINEL_TABLE = "users";

export async function ensureSchema(): Promise<void> {
  // From apps/server/src/infra/database/ → apps/server/src/ (3 levels) →
  // apps/server/ (4) → apps/ (5) → occa/ (5) → occa/drizzle/.
  const migrationsFolder = path.resolve(__dirname, "../../../../../drizzle");

  // Self-heal pass FIRST. If a previous run somehow left the journal table
  // out of sync with the migrations folder (e.g. journal `when` timestamps
  // backdated below already-recorded `created_at`, drizzle-kit silent
  // no-op, partially-applied chain via psql), stamp the missing rows so
  // drizzle's migrator sees an accurate picture before deciding what to
  // re-run. Only stamps when the underlying schema actually has the
  // expected tables — i.e. a sentinel-guarded heuristic identical to the
  // post-DUPLICATE_TABLE catch path, but proactive.
  if (await hasAppSentinel()) {
    await syncMigrationJournal(migrationsFolder);
  }

  try {
    await migrate(db, { migrationsFolder });
    log.info("Migrations applied");
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code === PG_ERROR_CODES.DUPLICATE_TABLE) {
      const sentinelExists = await hasAppSentinel();
      if (!sentinelExists) {
        // Migration chain broke on a fresh DB — fail loud instead of marking
        // the journal as done and handing the server a half-built schema.
        log.error(
          { err },
          "migration failed with DUPLICATE_TABLE but sentinel table is missing — schema is broken, refusing to mark migrations as applied",
        );
        throw err;
      }
      log.info("Tables already exist, syncing migration journal...");
      await syncMigrationJournal(migrationsFolder);
    } else {
      log.error({ err }, "Migration failed");
      throw err;
    }
  }
}

async function hasAppSentinel(): Promise<boolean> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_tables
         WHERE schemaname = 'public' AND tablename = $1
       ) AS exists`,
      [APP_SENTINEL_TABLE],
    );
    return !!rows[0]?.exists;
  } finally {
    client.release();
  }
}

/**
 * Idempotent stamp of `drizzle.__drizzle_migrations` against the SQL files
 * on disk. Two correctness invariants:
 *
 *  1. **Schema** — drizzle-orm's node-postgres migrator stores its journal
 *     in the `drizzle` schema, NOT `public`. Earlier versions of this
 *     helper wrote to `public.__drizzle_migrations`, which the migrator
 *     never reads, so subsequent boots kept silently re-attempting (or
 *     worse, silently skipping) migrations.
 *  2. **Hash format** — the migrator compares SHA256 of the SQL file
 *     content. Storing `entry.tag` would never match.
 *
 * Why this exists at all: drizzle-kit's `migrate` command sometimes
 * silently no-ops when journal `when` values are backdated below the
 * latest `created_at` in the table (it interprets the entries as already
 * applied). The recovery path applies the SQL via psql and stamps here.
 */
async function syncMigrationJournal(migrationsFolder: string): Promise<void> {
  const journalPath = path.resolve(migrationsFolder, "meta/_journal.json");
  if (!fs.existsSync(journalPath)) {
    log.info("No migration journal found, skipping sync.");
    return;
  }
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };

  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

    let stamped = 0;
    for (const entry of journal.entries) {
      const sqlPath = path.resolve(migrationsFolder, `${entry.tag}.sql`);
      if (!fs.existsSync(sqlPath)) {
        log.warn({ tag: entry.tag }, "journal entry has no SQL file, skipping");
        continue;
      }
      const sql = fs.readFileSync(sqlPath, "utf-8");
      const hash = crypto.createHash("sha256").update(sql).digest("hex");
      const exists = await client.query(
        `SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = $1`,
        [hash],
      );
      if (exists.rows.length === 0) {
        await client.query(
          `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
          [hash, entry.when ?? Date.now()],
        );
        stamped++;
      }
    }
    if (stamped > 0) {
      log.info({ stamped }, "Migration journal stamped missing entries");
    }
  } finally {
    client.release();
  }
}
