import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client";
import path from "node:path";
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

async function syncMigrationJournal(migrationsFolder: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
    const fs = await import("fs");
    const journalPath = path.resolve(migrationsFolder, "meta/_journal.json");
    if (!fs.existsSync(journalPath)) {
      log.info("No migration journal found, skipping sync.");
      return;
    }
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8"));
    for (const entry of journal.entries) {
      const exists = await client.query(
        `SELECT 1 FROM "__drizzle_migrations" WHERE hash = $1`,
        [entry.tag],
      );
      if (exists.rows.length === 0) {
        await client.query(
          `INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
          [entry.tag, entry.when ?? Date.now()],
        );
      }
    }
    log.info("Migration journal synced");
  } finally {
    client.release();
  }
}
