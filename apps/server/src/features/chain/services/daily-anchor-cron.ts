// Daily-anchor cron — schedules `runDailyAnchor()` to commit yesterday's
// UTC day shortly after midnight. Mirrors the start/stop pattern of the
// workflow trigger poller so server lifecycle hooks own the timer.
//
// Cadence design:
//   • Cron tick every hour. On each tick, check whether we've already
//     anchored YESTERDAY's UTC day in this process run. If not, run it.
//   • Idempotent against process restarts — chain itself enforces single
//     DailyAnchor per (deployment, day), so re-firing after a crash just
//     hits the `already_anchored` short-circuit and does nothing.
//   • Hourly (not at-fixed-time) so the window opens within 60min of
//     midnight UTC even if server restarts during the night.
//
// Why not pg-boss cron: pg-boss cron is in the worker. The Solana code +
// operator keypair live in the server. Crossing apps to call into chain
// logic would mean adding HTTP plumbing + auth between worker/server.
// A server-internal setInterval is simpler and matches workflow-trigger
// -poller's precedent.

import { childLogger } from "../../../lib/logger";
import { runDailyAnchor, SECONDS_PER_DAY, startOfUtcDay } from "./daily-anchor-engine";

const log = childLogger("daily-anchor-cron");

// Hourly tick. Cheap — most ticks no-op because already-anchored short
// circuits early.
const TICK_INTERVAL_MS = 60 * 60 * 1_000;

let timer: NodeJS.Timeout | null = null;
let lastAnchoredDayUnix = 0;
let inFlight = false;

async function tick(): Promise<void> {
  if (inFlight) {
    log.debug("tick already in flight — skip");
    return;
  }
  inFlight = true;

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    // Anchor YESTERDAY's UTC day. Anchoring today's would be premature
    // (more traces will land before midnight).
    const todayStart = startOfUtcDay(nowSec);
    const dayToAnchor = todayStart - SECONDS_PER_DAY;

    if (lastAnchoredDayUnix === dayToAnchor) {
      // Already handled this process tick. Chain still authoritative;
      // this is just to skip redundant runs within one server run.
      return;
    }

    log.info({ dayUnix: dayToAnchor }, "daily anchor cron tick — running");
    const summary = await runDailyAnchor(dayToAnchor);
    lastAnchoredDayUnix = dayToAnchor;
    log.info(
      {
        dayUnix: dayToAnchor,
        anchored: summary.anchored,
        alreadyAnchored: summary.alreadyAnchored,
        skippedEmpty: summary.skippedEmpty,
        skippedInvalidPda: summary.skippedInvalidPda,
        failed: summary.failed,
        companiesSkipped: summary.companiesSkipped.length,
      },
      "daily anchor cron tick complete",
    );
  } catch (err) {
    log.error({ err }, "daily anchor tick failed");
  } finally {
    inFlight = false;
  }
}

export function startDailyAnchorCron(): void {
  if (timer) return;
  log.info({ intervalMs: TICK_INTERVAL_MS }, "daily anchor cron starting");
  // Fire once on boot so a server restart shortly after midnight still
  // catches the prior-day window without waiting up to 60min.
  void tick();
  timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
}

export function stopDailyAnchorCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  log.info("daily anchor cron stopped");
}
