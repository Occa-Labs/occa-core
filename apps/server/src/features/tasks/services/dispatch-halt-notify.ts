// Dispatch-halt notifier — when the task dispatcher stops before handing
// work to an agent, the task sits in its column with no signal and the
// board looks frozen. This emits one operator notification carrying the
// reason so a stalled task is visible (in-app inbox + channel fan-out)
// instead of living only in a `log.warn`.
//
// The task is NOT mutated here — a budget halt resumes on its own next
// month, so the row stays `todo` rather than being marked errored. This is
// purely the visibility signal.
//
// Best-effort: every failure is swallowed so the notify path can never
// throw into or block the dispatch path (mirrors emitNotification fan-out).
//
// Dedup keeps a stalled cycle from flooding the inbox:
//   - budget_exhausted: once per company per calendar month, matching the
//     monthly budget reset cadence (see company-budget.ts).
//   - agent_unavailable: once per (company, task) per 24h, so a repeatedly
//     re-enqueued stuck task pings once but a genuinely new one still does.

import { and, eq, gte, sql } from "drizzle-orm";
import { companies, notifications } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";
import { emitNotification } from "../../notifications/services/emit";

const log = childLogger("services:dispatch-halt-notify");

const KIND = "task_dispatch_halted";
const AGENT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type DispatchHaltReason = "budget_exhausted" | "agent_unavailable";

export interface DispatchHaltInput {
  companyId: string;
  taskId: string;
  taskNumber: number;
  taskTitle: string;
  reason: DispatchHaltReason;
  /** Human detail for the body, e.g. "agent runtime not provisioned". */
  detail: string;
}

export async function notifyDispatchHalted(
  input: DispatchHaltInput,
): Promise<void> {
  try {
    const [company] = await db
      .select({ ownerUserId: companies.ownerUserId })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .limit(1);
    if (!company) return;

    if (await isDeduped(input)) return;

    await emitNotification({
      companyId: input.companyId,
      userId: company.ownerUserId,
      kind: KIND,
      title: titleFor(input),
      body: bodyFor(input),
      payload: {
        taskId: input.taskId,
        taskNumber: input.taskNumber,
        reason: input.reason,
      },
      link: `tasks:${input.taskId}`,
    });
    log.info(
      { taskId: input.taskId, reason: input.reason },
      "dispatch-halt notification emitted",
    );
  } catch (err) {
    log.warn({ err, taskId: input.taskId }, "dispatch-halt notify failed");
  }
}

// First instant of the current calendar month, UTC — mirrors
// company-budget.ts so the budget dedup window lines up with the reset.
function currentMonthStartUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function isDeduped(input: DispatchHaltInput): Promise<boolean> {
  if (input.reason === "budget_exhausted") {
    const [row] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.companyId, input.companyId),
          eq(notifications.kind, KIND),
          sql`${notifications.payload} ->> 'reason' = 'budget_exhausted'`,
          gte(notifications.createdAt, currentMonthStartUtc()),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  const since = new Date(Date.now() - AGENT_DEDUPE_WINDOW_MS);
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.companyId, input.companyId),
        eq(notifications.kind, KIND),
        sql`${notifications.payload} ->> 'taskId' = ${input.taskId}`,
        gte(notifications.createdAt, since),
      ),
    )
    .limit(1);
  return Boolean(row);
}

function titleFor(input: DispatchHaltInput): string {
  return input.reason === "budget_exhausted"
    ? "Monthly budget reached"
    : "Agent unavailable";
}

function bodyFor(input: DispatchHaltInput): string {
  const label = `Task #${input.taskNumber} "${input.taskTitle}"`;
  if (input.reason === "budget_exhausted") {
    return `${label} is waiting to start. Month-to-date spend reached the company budget, so no new work starts this month. It resumes automatically next calendar month, or sooner if you raise the budget.`;
  }
  return `${label} could not start. ${input.detail}. Check the assigned agent's runtime, then re-assign or retry the task.`;
}
