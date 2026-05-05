import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@occa/shared/schema";

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://localhost:5432/occa",
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  console.error("[worker:db] Unexpected pool error:", err.message);
});

export const db = drizzle(pool, { schema });

// Worker doesn't run migrations — that's the server's job. But the worker
// can boot faster than the server's `ensureSchema` finishes, especially
// after a fresh DB reset. Polling for the `agents` table avoids loud
// "relation ... does not exist" loops on every probe tick during the gap.
export async function waitForSchema({
  timeoutMs = 60_000,
  intervalMs = 1_000,
}: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await pool.query<{ exists: boolean }>(
        `select exists (
           select 1 from information_schema.tables
           where table_schema = 'public' and table_name = 'agents'
         ) as exists`,
      );
      if (res.rows[0]?.exists) return;
    } catch {
      // pool not ready yet — retry
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `[worker] schema not ready after ${timeoutMs}ms — is the server running migrations?`,
  );
}
