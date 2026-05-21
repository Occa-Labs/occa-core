// Pure cron helpers for the routines feature. `cron-parser` is a
// computation library (no I/O), so this stays in the domain layer.

import { CronExpressionParser } from "cron-parser";
import { ERROR_CODES } from "@occa/shared/error-codes";
import type { TriggerInput } from "./schemas";

// Next fire time for a cron expression, or null if the expression is
// invalid. Callers stamp this onto a trigger's `next_run_at`.
export function computeNextRun(
  cronExpression: string,
  timezone: string | null,
): Date | null {
  try {
    const iter = CronExpressionParser.parse(cronExpression, {
      tz: timezone ?? undefined,
    });
    return iter.next().toDate();
  } catch {
    return null;
  }
}

export function isValidCron(
  cronExpression: string,
  timezone?: string | null,
): boolean {
  try {
    CronExpressionParser.parse(cronExpression, {
      tz: timezone ?? undefined,
    });
    return true;
  } catch {
    return false;
  }
}

// A cron trigger must carry a valid cron expression; other kinds pass
// through. Returns an ERROR_CODES value on failure for the route to
// surface verbatim.
export function validateTriggerInput(input: TriggerInput): {
  ok: boolean;
  error?: string;
} {
  if (input.kind === "cron") {
    if (!input.cronExpression) {
      return { ok: false, error: ERROR_CODES.CRON_REQUIRED };
    }
    if (!isValidCron(input.cronExpression, input.timezone)) {
      return { ok: false, error: ERROR_CODES.INVALID_CRON_EXPRESSION };
    }
  }
  return { ok: true };
}
