// Public, unauthenticated, read-only endpoints — back scan.occaai.com.
// Surfaces enriched on-chain activity (PDA → human names) without
// exposing any operational state (no API keys, no wallets-as-config,
// no private flags).
//
// All routes:
//   - read-only (no POST/PUT/DELETE)
//   - no auth middleware
//   - cap pagination to prevent abuse
//
// Coupled to: services/transactions-aggregator (reused for both per-
// company and global feeds). DB lookups read directly from companies +
// deployments + agent_identities.

import { Router, type Request, type Response } from "express";
import { StatusCodes } from "http-status-codes";
import { and, eq, isNotNull, sql, inArray } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import { formatChainError } from "@occa/sdk";
import {
  agentIdentities,
  companies,
  deployments,
} from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { getConnection } from "../../../infra/solana/connection";
import { childLogger } from "../../../lib/logger";
import { listCompanyTransactions } from "../services/transactions-aggregator";
import {
  computeReputation,
  getAgentReputation,
} from "../services/reputation-lookup";

const log = childLogger("routes:public");

const router: Router = Router();

const PER_PAGE_DEFAULT = 10;
const PER_PAGE_MAX = 50;
const GLOBAL_FEED_PER_COMPANY = 5;
const GLOBAL_FEED_COMPANIES_MAX = 5;

function clampLimit(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? PER_PAGE_DEFAULT), 10);
  if (!Number.isFinite(n) || n < 1) return PER_PAGE_DEFAULT;
  return Math.min(n, PER_PAGE_MAX);
}

// ── GET /api/public/companies ────────────────────────────────────────
// List all anchored companies, with agent counts.
router.get("/companies", async (_req: Request, res: Response) => {
  try {
    const rows = await db
      .select({
        pda: companies.companyPda,
        name: companies.name,
        ownerWallet: companies.ownerWallet,
        createdAt: companies.createdAt,
        id: companies.id,
      })
      .from(companies)
      .where(and(eq(companies.kind, "user"), isNotNull(companies.companyPda)));

    // Per-company agent count via single grouped query.
    const ids = rows.map((r) => r.id);
    const counts =
      ids.length === 0
        ? []
        : await db
            .select({
              companyId: deployments.companyId,
              count: sql<number>`cast(count(*) as int)`,
            })
            .from(deployments)
            .where(inArray(deployments.companyId, ids))
            .groupBy(deployments.companyId);
    const countByCo = new Map(counts.map((c) => [c.companyId, c.count]));

    const records = rows
      .filter((r) => r.pda)
      .map((r) => ({
        pda: r.pda as string,
        name: r.name,
        ownerWallet: r.ownerWallet ?? "",
        createdAt: r.createdAt.toISOString(),
        agentCount: countByCo.get(r.id) ?? 0,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    res.status(StatusCodes.OK).json({ records });
  } catch (err) {
    log.error({ err }, "list companies failed");
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "internal" });
  }
});

// ── GET /api/public/companies/:pda ───────────────────────────────────
router.get("/companies/:pda", async (req: Request, res: Response) => {
  try {
    const [row] = await db
      .select({
        pda: companies.companyPda,
        name: companies.name,
        ownerWallet: companies.ownerWallet,
        chainStatus: companies.chainStatus,
        createdAt: companies.createdAt,
      })
      .from(companies)
      .where(eq(companies.companyPda, req.params.pda))
      .limit(1);
    if (!row || !row.pda) {
      res.status(StatusCodes.NOT_FOUND).json({ error: "not_found" });
      return;
    }
    res.status(StatusCodes.OK).json({
      pda: row.pda,
      name: row.name,
      ownerWallet: row.ownerWallet ?? "",
      chainStatus: row.chainStatus ?? null,
      createdAt: row.createdAt.toISOString(),
    });
  } catch (err) {
    log.error({ err, pda: req.params.pda }, "get company failed");
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "internal" });
  }
});

// ── GET /api/public/agents/:pda ──────────────────────────────────────
router.get("/agents/:pda", async (req: Request, res: Response) => {
  try {
    const [row] = await db
      .select({
        pda: deployments.deploymentPda,
        role: deployments.role,
        name: agentIdentities.name,
        companyPda: companies.companyPda,
        companyName: companies.name,
      })
      .from(deployments)
      .innerJoin(
        agentIdentities,
        eq(deployments.agentIdentityId, agentIdentities.id),
      )
      .innerJoin(companies, eq(deployments.companyId, companies.id))
      .where(eq(deployments.deploymentPda, req.params.pda))
      .limit(1);
    if (!row) {
      res.status(StatusCodes.NOT_FOUND).json({ error: "not_found" });
      return;
    }
    res.status(StatusCodes.OK).json({
      pda: row.pda,
      name: row.name,
      role: row.role,
      companyPda: row.companyPda ?? "",
      companyName: row.companyName,
    });
  } catch (err) {
    log.error({ err, pda: req.params.pda }, "get agent failed");
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "internal" });
  }
});

// ── GET /api/public/agents/:pda/reputation ───────────────────────────
// Reputation derived from the agent's on-chain TraceAnchors. `:pda` is a
// deployment PDA (matching GET /agents/:pda); reputation aggregates the
// underlying AgentIdentity's full track record across all deployments.
router.get("/agents/:pda/reputation", async (req: Request, res: Response) => {
  try {
    const [row] = await db
      .select({ identityPda: agentIdentities.identityPda })
      .from(deployments)
      .innerJoin(
        agentIdentities,
        eq(deployments.agentIdentityId, agentIdentities.id),
      )
      .where(eq(deployments.deploymentPda, req.params.pda))
      .limit(1);
    if (!row) {
      res.status(StatusCodes.NOT_FOUND).json({ error: "not_found" });
      return;
    }
    // Un-anchored identities carry a synthetic placeholder, not a real
    // PDA — they have no on-chain traces, so return an empty reputation
    // rather than erroring.
    let identityPda: PublicKey;
    try {
      identityPda = new PublicKey(row.identityPda);
    } catch {
      res.status(StatusCodes.OK).json(computeReputation(row.identityPda, []));
      return;
    }
    const reputation = await getAgentReputation(identityPda);
    res.status(StatusCodes.OK).json(reputation);
  } catch (err) {
    log.error({ err, pda: req.params.pda }, "get agent reputation failed");
    res.status(StatusCodes.BAD_GATEWAY).json({ error: "chain_unreachable" });
  }
});

// ── GET /api/public/companies/:pda/transactions ──────────────────────
router.get(
  "/companies/:pda/transactions",
  async (req: Request, res: Response) => {
    try {
      const [row] = await db
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(eq(companies.companyPda, req.params.pda))
        .limit(1);
      if (!row) {
        res.status(StatusCodes.NOT_FOUND).json({ error: "not_found" });
        return;
      }
      const limit = clampLimit(req.query.limit);
      const before =
        typeof req.query.before === "string" ? req.query.before : undefined;
      const result = await listCompanyTransactions({
        companyPda: new PublicKey(req.params.pda),
        companyId: row.id,
        limit,
        before,
      });
      const records = result.records.map((r) => ({
        signature: r.signature,
        slot: r.slot,
        blockTime: r.blockTime,
        action: r.action,
        signer: r.signer,
        err: r.err,
        companyPda: req.params.pda,
        companyName: row.name,
      }));
      res.status(StatusCodes.OK).json({ records, hasMore: result.hasMore });
    } catch (err) {
      log.error(
        { err, pda: req.params.pda },
        "list company transactions failed",
      );
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: "chain_unreachable" });
    }
  },
);

// ── GET /api/public/transactions ─────────────────────────────────────
// Global feed — last N transactions across ALL anchored companies.
// Strategy: fetch the most-active companies' transaction lists in
// parallel, merge, sort by blockTime desc, slice to limit.
router.get("/transactions", async (req: Request, res: Response) => {
  try {
    const limit = clampLimit(req.query.limit);
    const cos = await db
      .select({
        id: companies.id,
        pda: companies.companyPda,
        name: companies.name,
      })
      .from(companies)
      .where(and(eq(companies.kind, "user"), isNotNull(companies.companyPda)))
      .limit(GLOBAL_FEED_COMPANIES_MAX);

    const perCompanyResults = await Promise.all(
      cos
        .filter((c) => c.pda)
        .map(async (c) => {
          try {
            const r = await listCompanyTransactions({
              companyPda: new PublicKey(c.pda as string),
              companyId: c.id,
              limit: GLOBAL_FEED_PER_COMPANY,
            });
            return r.records.map((rec) => ({
              ...rec,
              companyPda: c.pda as string,
              companyName: c.name,
            }));
          } catch (err) {
            log.warn(
              { err, companyId: c.id },
              "per-company feed fetch failed (skipped)",
            );
            return [];
          }
        }),
    );

    const all = perCompanyResults.flat();
    all.sort((a, b) => {
      const at = a.blockTime ?? 0;
      const bt = b.blockTime ?? 0;
      if (bt !== at) return bt - at;
      return b.slot - a.slot;
    });
    const records = all.slice(0, limit);
    res.status(StatusCodes.OK).json({ records, hasMore: all.length > limit });
  } catch (err) {
    log.error({ err }, "global transactions feed failed");
    res
      .status(StatusCodes.BAD_GATEWAY)
      .json({ error: "chain_unreachable" });
  }
});

// ── GET /api/public/transactions/:sig ────────────────────────────────
router.get("/transactions/:sig", async (req: Request, res: Response) => {
  try {
    const conn = getConnection();
    const tx = await conn.getTransaction(req.params.sig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx) {
      res.status(StatusCodes.NOT_FOUND).json({ error: "not_found" });
      return;
    }
    const msg = tx.transaction.message;
    const accountKeys = msg.getAccountKeys ? msg.getAccountKeys() : null;
    const signer = accountKeys
      ? accountKeys.get(0)?.toBase58() ?? null
      : null;
    const accounts: string[] = [];
    if (accountKeys) {
      for (let i = 0; i < accountKeys.length; i++) {
        const k = accountKeys.get(i);
        if (k) accounts.push(k.toBase58());
      }
    }
    // discriminator decode — share label table later if needed; for now
    // ix detail is left null since the per-company feed already labels
    // common OCCA ix. This page is the deep-dive view.
    const action: string | null = null;
    res.status(StatusCodes.OK).json({
      signature: req.params.sig,
      blockTime: tx.blockTime ?? null,
      slot: tx.slot,
      fee: tx.meta?.fee ?? null,
      action,
      signer,
      accounts,
      err: tx.meta?.err ? formatChainError(tx.meta.err) : null,
    });
  } catch (err) {
    log.error({ err, sig: req.params.sig }, "get transaction failed");
    res
      .status(StatusCodes.BAD_GATEWAY)
      .json({ error: "chain_unreachable" });
  }
});

export default router;
