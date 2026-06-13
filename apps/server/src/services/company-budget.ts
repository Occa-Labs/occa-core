// Company token-spend budget — the monthly pool that bounds ALL
// token-consuming activity (task runs + chat) for one company.
//
// Model:
//   • One operator-set pool per company (`companies.monthly_budget_cents`).
//   • Spend is NOT capped per run — individual runs are never truncated.
//   • The gate is at the START of new work: callers (task dispatcher, chat
//     handler) ask `isWithinBudget` before spending. Once month-to-date
//     spend reaches the pool, no new run starts until next calendar month.
//   • Month-to-date spend is summed live from `traces.usage_json.costCents`,
//     so the monthly reset is implicit — no accumulator, no reset job.
//
// Lives in the legacy `services/` spine (not a feature) because it is shared
// across features (tasks dispatch, chat, companies routes) and must not
// introduce a cross-feature import.

import { and, eq, gte, sql } from "drizzle-orm";
import { companies, traces } from "@occa/shared/schema";
import { db } from "../infra/database/client";

export interface CompanyBudgetStatus {
  /** Operator-set monthly pool, US cents. */
  budgetCents: number;
  /** Month-to-date token spend, US cents. */
  spentCents: number;
  /** True while there is room to start new work this month. */
  withinBudget: boolean;
}

// First instant of the current calendar month, UTC. Spend before this is a
// previous period and doesn't count against the live pool.
function currentMonthStartUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// Sum the cost of every trace this company has run since the month began.
// `usage_json` is the per-run usage blob ({ tokensIn, costCents, ... });
// traces without usage (e.g. openclaw, failed-before-spend) contribute 0.
export async function getCompanyMonthSpendCents(
  companyId: string,
): Promise<number> {
  const [row] = await db
    .select({
      spent: sql<number>`COALESCE(SUM((${traces.usageJson} ->> 'costCents')::numeric), 0)`,
    })
    .from(traces)
    .where(
      and(
        eq(traces.companyId, companyId),
        gte(traces.createdAt, currentMonthStartUtc()),
      ),
    );
  return Math.round(Number(row?.spent ?? 0));
}

export async function getCompanyBudgetStatus(
  companyId: string,
): Promise<CompanyBudgetStatus> {
  const [companyRow] = await db
    .select({ budgetCents: companies.monthlyBudgetCents })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  const budgetCents = companyRow?.budgetCents ?? 0;
  const spentCents = await getCompanyMonthSpendCents(companyId);
  return {
    budgetCents,
    spentCents,
    withinBudget: spentCents < budgetCents,
  };
}
