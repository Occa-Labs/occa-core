// Failure retry schedule. Entry at index N is the delay before attempt N+1.
// After the last entry, retries are exhausted and the trace surfaces to
// notifications. The count lives in @occa/shared/errors so notification
// derivation on the server can read it too.
import { MAX_RETRY_ATTEMPTS as SHARED_MAX } from "@occa/shared/errors";

export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
if (RETRY_DELAYS_MS.length !== SHARED_MAX) {
  throw new Error(
    "retry-policy: RETRY_DELAYS_MS.length must equal shared MAX_RETRY_ATTEMPTS",
  );
}
export const MAX_RETRY_ATTEMPTS = SHARED_MAX;

export function nextRetryDelayMs(attemptIndex: number): number | null {
  if (attemptIndex < 0 || attemptIndex >= RETRY_DELAYS_MS.length) return null;
  return RETRY_DELAYS_MS[attemptIndex];
}
