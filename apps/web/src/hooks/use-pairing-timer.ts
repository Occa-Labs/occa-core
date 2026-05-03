"use client";

import { useEffect, useState } from "react";

const PAIRING_REQUEST_TTL_SEC = 300; // OpenClaw expires pending requests after 5 minutes.

export interface PairingTimerState {
  /** Seconds remaining until the pending request expires. 0 once expired. */
  remaining: number;
  /** True when the gateway-side pending request has timed out. */
  expired: boolean;
  /** Pre-formatted "M:SS" string for direct rendering. */
  formatted: string;
}

/**
 * Tracks the 5-minute window OpenClaw gives users to approve a pending pair
 * request. Caller drives lifecycle via two inputs:
 *
 *  - `active`   — when true the timer is running. Flip false (e.g. when error
 *                 clears) to stop it.
 *  - `restartKey` — bump to force a restart even if `active` stayed true
 *                   (e.g. the user clicked Retry, which produces a fresh
 *                   pending request on the gateway).
 */
export function usePairingTimer(
  active: boolean,
  restartKey: number,
  durationSec: number = PAIRING_REQUEST_TTL_SEC,
): PairingTimerState {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (active) {
      const t = Date.now();
      setStartedAt(t);
      setNow(t);
    } else {
      setStartedAt(null);
    }
  }, [active, restartKey]);

  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const elapsed = startedAt ? Math.floor((now - startedAt) / 1000) : 0;
  const remaining = Math.max(0, durationSec - elapsed);
  const expired = startedAt !== null && remaining <= 0;

  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  const formatted = `${m}:${s.toString().padStart(2, "0")}`;

  return { remaining, expired, formatted };
}
