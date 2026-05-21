import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { and, eq, isNull } from "drizzle-orm";
import {
  deprovisionAgent,
  deserializeKeypair,
  listGatewayAgents,
  type SerializedKeypair,
} from "@occa/adapter-openclaw";
import { db } from "../infra/database/client";
import {
  agentIdentities,
  agentRuntimeProfile,
  approvals,
  companies,
  deployments,
} from "@occa/shared/schema";
import { requireAuth, requireDevWallet } from "../middleware/auth";

const router: Router = Router();

// Prefix on every OpenClaw agent id that OCCA provisions. Used to limit the
// GC sweep below to our own entries — user-added agents like `main` / `test2`
// are never touched.
const OCCA_AGENT_PREFIX = "occa-";

// POST /api/dev/gc-orphan-openclaw-agents
// Dev-only: delete OpenClaw agents prefixed `occa-` that no longer have a
// matching row in OCCA's `agents` table. Uses creds from one of the user's
// existing agents (takes the most recent) so we can authenticate to their
// gateway. Safe by construction — never deletes non-`occa-` entries, never
// touches an `occa-*` id that's still bound to a DB row.
//
// Returns a summary: what was on the gateway, which we considered orphan,
// and which were successfully removed. `dryRun=true` query param skips the
// actual deprovision so callers can preview the sweep.
router.post(
  "/gc-orphan-openclaw-agents",
  requireAuth,
  requireDevWallet,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const dryRun = req.query.dryRun === "true" || req.query.dryRun === "1";

    // Find the user's company (non-deleted). We GC per-company — if the user
    // has no company they also have no gateway creds to authenticate with.
    const [company] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          eq(companies.ownerUserId, userId),
          eq(companies.kind, "user"),
          isNull(companies.deletedAt),
        ),
      )
      .limit(1);
    if (!company) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.NO_COMPANY });
      return;
    }

    // Pull every runtime profile in this company (paired with its
    // deployment for the externalAgentId used by the orphan diff). All
    // entries for the same company currently share gateway + apiKey;
    // keypairs differ. We just need one valid set to connect.
    const allProfiles = await db
      .select({
        externalAgentId: agentRuntimeProfile.externalAgentId,
        adapterConfig: agentRuntimeProfile.adapterConfig,
      })
      .from(agentRuntimeProfile)
      .where(eq(agentRuntimeProfile.companyId, company.id));
    if (allProfiles.length === 0) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.NO_AGENT_CREDS_AVAILABLE });
      return;
    }
    const credSource = allProfiles.find((a) => {
      const c = (a.adapterConfig ?? {}) as Record<string, unknown>;
      return (
        typeof c.gatewayUrl === "string" &&
        typeof c.apiKey === "string" &&
        !!c.deviceKeypair
      );
    });
    if (!credSource) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.NO_AGENT_CREDS_AVAILABLE });
      return;
    }
    const cfg = credSource.adapterConfig as Record<string, unknown>;
    const gatewayUrl = cfg.gatewayUrl as string;
    const apiKey = cfg.apiKey as string;
    const device = deserializeKeypair(cfg.deviceKeypair as SerializedKeypair);

    const listed = await listGatewayAgents({ gatewayUrl, apiKey, device });
    if (!listed.ok) {
      res.status(StatusCodes.BAD_GATEWAY).json({
        error: ERROR_CODES.GATEWAY_LIST_FAILED,
        detail: { code: listed.error, reason: listed.reason },
      });
      return;
    }

    const knownExternalIds = new Set(
      allProfiles
        .map((a) => a.externalAgentId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );

    const onGateway = listed.agents.map((a) => a.id);
    const orphans = listed.agents
      .map((a) => a.id)
      .filter(
        (id) => id.startsWith(OCCA_AGENT_PREFIX) && !knownExternalIds.has(id),
      );

    if (dryRun) {
      res.json({
        ok: true,
        dryRun: true,
        onGateway,
        knownInOcca: Array.from(knownExternalIds),
        orphans,
      });
      return;
    }

    const removed: string[] = [];
    const failures: Array<{ id: string; error: string; reason?: string }> = [];
    for (const orphanId of orphans) {
      const result = await deprovisionAgent({
        gatewayUrl,
        apiKey,
        device,
        externalAgentId: orphanId,
      });
      if (result.ok) {
        removed.push(orphanId);
      } else {
        failures.push({
          id: orphanId,
          error: result.error,
          reason: result.reason,
        });
      }
    }

    res.json({
      ok: failures.length === 0,
      onGateway,
      knownInOcca: Array.from(knownExternalIds),
      orphans,
      removed,
      failures,
    });
  },
);

// ── POST /api/dev/seed-approval ───────────────────────────────────────────────
// Dev-only: insert a fake `pending` approval so the notification UI can be
// exercised without manually crafting rows in Drizzle Studio. Picks the
// caller's first agent as the requester (or null if no agents exist) and
// rotates a small set of plausible action types so multiple seed clicks
// produce a varied feed instead of duplicate cards.

interface SeedApprovalFixture {
  actionType: string;
  payload: Record<string, unknown>;
}

const STATIC_FIXTURES: SeedApprovalFixture[] = [
  {
    actionType: "spend.usdc",
    payload: {
      summary: "Wants to spend 0.5 SOL on Vercel Pro",
      recipient: "vendor-vercel",
      amount: "0.5 SOL",
      note: "annual renewal",
    },
  },
  {
    actionType: "github.merge_pr",
    payload: {
      summary: "Wants to merge PR #142",
      repo: "occa/occa",
      pr: 142,
      title: "feat: notification center",
    },
  },
  {
    actionType: "skill.install",
    payload: {
      summary: "Wants to install skill `solana-tx-signer`",
      skill: "openclaw/solana-tx-signer",
      version: "0.3.1",
    },
  },
  {
    actionType: "treasury.transfer",
    payload: {
      summary: "Wants to send 25 USDC to a contractor",
      recipient: "9zN…r4Pq",
      amount: "25 USDC",
    },
  },
];

// Picks a delegate fixture if the company has at least 2 agents (one as
// requester, one as target); otherwise falls back to the static set so a
// solo-agent setup still produces something to look at.
function buildDelegateFixture(
  agentRows: { id: string; name: string; role: string }[],
): SeedApprovalFixture | null {
  if (agentRows.length < 2) return null;
  const [, target] = agentRows;
  return {
    actionType: "delegate",
    payload: {
      targetAgentId: target.id,
      title: `Build the ${target.role} prototype`,
      description: `Spin up a first cut of the ${target.role} workstream so we can iterate. Cover the obvious surface area; ship something we can review.`,
      acceptanceCriteria:
        "A working draft posted back to this task with the high-level approach + open questions.",
    },
  };
}

router.post(
  "/seed-approval",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const [company] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          eq(companies.ownerUserId, userId),
          eq(companies.kind, "user"),
          isNull(companies.deletedAt),
        ),
      )
      .limit(1);
    if (!company) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.NO_COMPANY });
      return;
    }

    // Pull the first two deployments. If we have at least two, the
    // requester is agentRows[0] (typically the CEO / first-onboarded)
    // and the delegate target is agentRows[1] — gives the "CTO delegates
    // to Engineer" flavour. Names come from `agent_identities` via JOIN.
    const agentRows = await db
      .select({
        id: deployments.id,
        name: agentIdentities.name,
        role: deployments.role,
      })
      .from(deployments)
      .innerJoin(
        agentIdentities,
        eq(deployments.agentIdentityId, agentIdentities.id),
      )
      .where(eq(deployments.companyId, company.id))
      .limit(5);

    const delegate = buildDelegateFixture(agentRows);
    const pool: SeedApprovalFixture[] = [
      ...(delegate ? [delegate] : []),
      ...STATIC_FIXTURES,
    ];
    const fixture = pool[Math.floor(Math.random() * pool.length)];

    const requesterId = agentRows[0]?.id ?? null;

    const [row] = await db
      .insert(approvals)
      .values({
        companyId: company.id,
        requestedByDeploymentId: requesterId,
        actionType: fixture.actionType,
        payload: fixture.payload,
      })
      .returning({ id: approvals.id });

    res.json({ ok: true, approvalId: row.id });
  },
);

export default router;
