// Error classifier — used by worker's retry policy to decide whether a
// failed trace deserves an automatic retry. Kept in @occa/shared so server
// routes surfacing retry state and the worker agree on the boundary.

export const TRANSIENT_ERROR_CODES = [
  "gateway_unreachable",
  "gateway_handshake_timeout",
  "timeout",
  "network_error",
  // `adapter_error` is ambiguous (catch-all from adapter execute). We treat
  // it as transient with the 3-retry cap as a safety net — if the root cause
  // is permanent, attempts will exhaust quickly (30s → 2m → 10m) and surface
  // to notifications.
  "adapter_error",
] as const;

export const PERMANENT_ERROR_CODES = [
  "unauthorized",
  "config_invalid",
  "device_pairing_required",
  "invalid_response",
  "cancelled",
] as const;

export function isTransientError(code: string | null | undefined): boolean {
  if (!code) return false;
  return (TRANSIENT_ERROR_CODES as readonly string[]).includes(code);
}

// Mirror of worker's RETRY_DELAYS_MS.length. Shared so the notifications
// derivation can decide whether a failed run's retries are exhausted.
export const MAX_RETRY_ATTEMPTS = 3;

// A failed run is "exhausted" (no further automatic retry will fire) when the
// error is permanent, or when the attempt counter has hit the cap.
export function isRetryExhausted(args: {
  errorCode: string | null;
  failureRetryAttempt: number;
}): boolean {
  if (!isTransientError(args.errorCode)) return true;
  return args.failureRetryAttempt >= MAX_RETRY_ATTEMPTS;
}
