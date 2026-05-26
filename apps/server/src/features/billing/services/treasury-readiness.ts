// Treasury readiness scanner — fires a `treasury_readiness` notification
// when a company has pending payable invoices the operator hasn't yet
// disbursed via "Run Payroll". Cron-driven, dedupe-aware.
//
// Why not auto-execute? Phase 1 design decision #7 (ratified 2026-05-07)
// keeps Disbursement signing operator-only by intent. Notifications are
// the readiness signal; the operator still clicks Run Payroll. See
// [[project_phase1_treasury_design]] for the trust model.
//
// Dedupe: at most one treasury_readiness notification per company per
// 24h window (read or unread). The check uses the latest row's
// createdAt — operator dismissing the notif doesn't unblock a new emit
// until 24h pass.

import { and, desc, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { companies, notifications } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";
import { emitNotification } from "../../notifications/services/emit";
import { buildDisbursementPlan } from "./disbursement";

const log = childLogger("services:treasury-readiness");

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ScanSummary {
  companiesChecked: number;
  emitted: number;
  skippedNoPayable: number;
  skippedDeduped: number;
  errors: number;
}

export async function scanTreasuryReadiness(): Promise<ScanSummary> {
  const summary: ScanSummary = {
    companiesChecked: 0,
    emitted: 0,
    skippedNoPayable: 0,
    skippedDeduped: 0,
    errors: 0,
  };

  // Anchored user companies (those with on-chain Registry presence). Only
  // anchored companies can run payroll, so scanning others is wasted.
  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      ownerUserId: companies.ownerUserId,
    })
    .from(companies)
    .where(
      and(
        eq(companies.kind, "user"),
        isNotNull(companies.companyPda),
        isNull(companies.deletedAt),
        isNull(companies.pausedAt),
      ),
    );

  for (const company of rows) {
    summary.companiesChecked += 1;
    try {
      const plan = await buildDisbursementPlan(company.id);
      if (plan.payable.length === 0 && plan.blocked.length === 0) {
        summary.skippedNoPayable += 1;
        continue;
      }
      const recent = await mostRecentForCompany(company.id);
      if (recent && Date.now() - recent.getTime() < DEDUPE_WINDOW_MS) {
        summary.skippedDeduped += 1;
        continue;
      }
      await emitNotification({
        companyId: company.id,
        userId: company.ownerUserId,
        kind: "treasury_readiness",
        title: titleFor(plan.payable.length, plan.blocked.length),
        body: bodyFor(plan.payable.length, plan.totalLamports, plan.blocked.length),
        payload: {
          payableAgents: plan.payable.length,
          payableLamports: plan.totalLamports,
          blockedAgents: plan.blocked.length,
        },
        link: "chain:treasury",
      });
      summary.emitted += 1;
    } catch (err) {
      summary.errors += 1;
      log.error({ err, companyId: company.id }, "scan company failed");
    }
  }

  log.info(summary, "treasury readiness scan complete");
  return summary;
}

async function mostRecentForCompany(companyId: string): Promise<Date | null> {
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
  const [row] = await db
    .select({ createdAt: notifications.createdAt })
    .from(notifications)
    .where(
      and(
        eq(notifications.kind, "treasury_readiness"),
        eq(notifications.companyId, companyId),
        gte(notifications.createdAt, since),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(1);
  return row?.createdAt ?? null;
}

function titleFor(payable: number, blocked: number): string {
  if (payable > 0 && blocked === 0) return `Payroll ready — ${payable} agent${payable === 1 ? "" : "s"} due`;
  if (payable > 0 && blocked > 0) return `Payroll ready — ${payable} due, ${blocked} blocked`;
  return `${blocked} agent${blocked === 1 ? "" : "s"} need a receiving address`;
}

function bodyFor(
  payable: number,
  totalLamports: number,
  blocked: number,
): string {
  const sol = (totalLamports / 1_000_000_000).toFixed(4);
  const main =
    payable > 0
      ? `${sol} SOL across ${payable} agent${payable === 1 ? "" : "s"} pending. Click to open Treasury and run payroll.`
      : "";
  const blockedNote =
    blocked > 0
      ? ` ${blocked} agent${blocked === 1 ? "" : "s"} blocked: no receiving address set.`
      : "";
  return (main + blockedNote).trim();
}
