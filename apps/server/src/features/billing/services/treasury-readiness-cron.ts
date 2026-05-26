// Treasury readiness cron — fires `scanTreasuryReadiness()` hourly so
// the operator gets an up-to-date "payroll ready" signal without manual
// polling. Mirrors daily-anchor-cron's start/stop pattern; server
// lifecycle hooks own the timer.
//
// Cadence: 1h tick. The scanner is dedupe-aware (24h window) so hourly
// ticks naturally collapse into at-most-once-per-day notifications per
// company. Hourly cadence (vs daily-at-midnight) gives a soft slew if the
// server restarts.

import { childLogger } from "../../../lib/logger";
import { scanTreasuryReadiness } from "./treasury-readiness";

const log = childLogger("treasury-readiness-cron");

const TICK_INTERVAL_MS = 60 * 60 * 1_000;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

async function tick(): Promise<void> {
  if (inFlight) {
    log.debug("tick already in flight — skip");
    return;
  }
  inFlight = true;
  try {
    log.info("tick — running");
    const summary = await scanTreasuryReadiness();
    log.info(summary, "tick complete");
  } catch (err) {
    log.error({ err }, "tick failed");
  } finally {
    inFlight = false;
  }
}

export function startTreasuryReadinessCron(): void {
  if (timer) return;
  log.info({ intervalMs: TICK_INTERVAL_MS }, "starting");
  void tick();
  timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
}

export function stopTreasuryReadinessCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  log.info("stopped");
}
