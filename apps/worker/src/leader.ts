import type { PoolClient } from "pg";
import { pool } from "./db";

// Distinct int64 key for the OCCA worker leader lock. Any number works as
// long as every worker uses the same. Kept in a namespace (high-32) + id
// (low-32) split so future workers can coexist without collision.
const NAMESPACE = 0x4f434341; // "OCCA"
const LOCK_KEY_ID = 1;

export interface LeaderHandle {
  client: PoolClient;
  release: () => Promise<void>;
}

export async function acquireLeader(): Promise<LeaderHandle> {
  const client = await pool.connect();
  const { rows } = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock($1, $2) AS locked",
    [NAMESPACE, LOCK_KEY_ID],
  );
  if (!rows[0]?.locked) {
    client.release();
    throw new Error("leader_already_held");
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [
        NAMESPACE,
        LOCK_KEY_ID,
      ]);
    } catch (err) {
      console.error(
        "[worker:leader] unlock error:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      client.release();
    }
  };
  return { client, release };
}
