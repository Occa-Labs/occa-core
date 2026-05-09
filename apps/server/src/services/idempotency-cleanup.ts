// Background cleanup for the `agent_action_idempotency` table.
// Records exist to dedupe HTTP retries; once an action is more than a
// week stale no agent is going to retry that key, so the row is just
// DB bloat. Runs once at server boot, then every 24h.
//
// Cleanup is best-effort: failures are logged and skipped, never bubbled
// up. The next tick retries.

import { lt } from "drizzle-orm";
import { agentActionIdempotency } from "@occa/shared/schema";
import { db } from "../infra/database/client";
import { childLogger } from "../lib/logger";

const log = childLogger("idempotency-cleanup");

const RETENTION_DAYS = 7;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export async function runIdempotencyCleanup(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const deleted = await db
      .delete(agentActionIdempotency)
      .where(lt(agentActionIdempotency.createdAt, cutoff))
      .returning({ id: agentActionIdempotency.id });
    if (deleted.length > 0) {
      log.info(
        { deleted: deleted.length, cutoff: cutoff.toISOString() },
        "idempotency cleanup pass complete",
      );
    }
  } catch (err) {
    log.warn({ err }, "idempotency cleanup tick failed");
  }
}

export function startIdempotencyCleanup(): void {
  if (timer) return;
  log.info(
    { retentionDays: RETENTION_DAYS, intervalHours: 24 },
    "idempotency cleanup starting",
  );
  // Fire once on boot — catches anything stale from before this code
  // existed. Subsequent ticks fire on a 24h cadence.
  void runIdempotencyCleanup();
  timer = setInterval(() => void runIdempotencyCleanup(), CLEANUP_INTERVAL_MS);
}

export function stopIdempotencyCleanup(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
