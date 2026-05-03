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
