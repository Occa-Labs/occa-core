import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
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
  authNonces,
  companies,
  companySkills,
  deployments,
  users,
} from "@occa/shared/schema";
import { requireAuth, requireDevWallet } from "../middleware/auth";

const router: Router = Router();
const execFileAsync = promisify(execFile);

// Prefix on every OpenClaw agent id that OCCA provisions. Used to limit the
// GC sweep below to our own entries — user-added agents like `main` / `test2`
// are never touched.
const OCCA_AGENT_PREFIX = "occa-";

// POST /api/dev/reset
// Dev-only: wipe all database rows except the requesting user. `companies`
// cascades to every downstream table (agents, tasks, skills, runs, events,
// wakeups, routines, sessions, runtime_state, api_keys, dismissals), so a
// bulk DELETE + cascade handles the tree. Other users (and their data) are
// also removed — this is intentionally aggressive; the dev tool's whole
// purpose is a clean slate.
//
// Platform-builtin skills (company_skills WHERE company_id IS NULL) survive
// the company cascade, so we wipe those explicitly. Without this, the
// lazy-fetch state on next provision is half-stale: ROLE_DEFAULT_SKILLS
// would skip the GitHub fetch (rows still cached) and reuse pre-reset
// commit SHAs, which is exactly the inconsistency dev reset is meant to
// flush.
router.post(
  "/reset",
  requireAuth,
  requireDevWallet,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const counts = await db.transaction(async (tx) => {
      const companiesDeleted = await tx
        .delete(companies)
        .returning({ id: companies.id });
      const skillsDeleted = await tx
        .delete(companySkills)
        .returning({ id: companySkills.id });
      const usersDeleted = await tx
        .delete(users)
        .where(ne(users.id, userId))
        .returning({ id: users.id });
      const noncesDeleted = await tx
        .delete(authNonces)
        .returning({ id: authNonces.id });
      // Clear the persisted OpenClaw device keypair from the surviving user.
      // After reset the gateway no longer has the previously-paired agent,
      // so reusing this keypair on next onboarding would fail probe. Force
      // a fresh pairing flow on next provision.
      const pendingCleared = await tx
        .update(users)
        .set({ pendingDeviceKeypair: null })
        .where(
          and(
            eq(users.id, userId),
            sql`${users.pendingDeviceKeypair} IS NOT NULL`,
          ),
        )
        .returning({ id: users.id });
      await tx.execute(sql`SELECT 1`);
      return {
        companies: companiesDeleted.length,
        platformSkills: skillsDeleted.length,
        otherUsers: usersDeleted.length,
        nonces: noncesDeleted.length,
        pendingDeviceKeypairCleared: pendingCleared.length,
      };
    });
    res.json({ ok: true, deleted: counts });
  },
);

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

// ── POST /api/dev/reset-gateway ───────────────────────────────────────────────
// Dev-only: SSH into the OpenClaw gateway VPS and remove every provisioned
// agent whose id starts with `occa-`. Two safety nets:
//   1. The `^occa-` prefix filter never matches user-managed agents like
//      `main` or `test2` (OCCA-provisioned ids are always `occa-<8hex>`).
//   2. OpenClaw's CLI itself refuses to delete `main`, so even if the filter
//      ever drifts, the protected agent survives.
// `openclaw agents delete` moves workspace + sessions to Trash on the VPS
// rather than hard-deleting, so a wrong call is recoverable on the host.
//
// Reads SSH config from env (OCCA_GATEWAY_SSH_HOST/USER/KEY). Returns a
// structured summary parsed from stdout so the UI can show what changed.
// `?dryRun=1` lists candidates without deleting.

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

// Defensive jq path covers both possible CLI JSON shapes (`[{id}]` vs
// `{agents:[{id}]}`); first run on a real gateway will tell us which one
// `openclaw agents list --json` actually emits.
const REMOTE_JQ_IDS = `jq -r '(if type==\"array\" then . else .agents // [] end) | .[].id // empty'`;

// `openclaw` is installed under root's nvm (the gateway runs `openclaw
// gateway` as root). The SSH user is non-root (`ubuntu`) by default and
// has no access to the binary, and `sudo` strips PATH so even an absolute
// path fails on the `/usr/bin/env node` shebang. Wrapping the remote
// command in `sudo -n bash -lc` with the nvm bin prepended to PATH makes
// both `node` and `openclaw` resolvable. `OCCA_GATEWAY_OPENCLAW_PATH`
// overrides the default if the install ever moves.
const DEFAULT_OPENCLAW_BIN_PATH = "/root/.nvm/versions/node/v24.15.0/bin";

function buildRemoteCmd(inner: string): string {
  const binPath =
    process.env.OCCA_GATEWAY_OPENCLAW_PATH ?? DEFAULT_OPENCLAW_BIN_PATH;
  // `sudo -n` fails fast if passwordless sudo isn't configured for the
  // user — better than hanging on a password prompt.
  return `sudo -n bash -lc ${shellSingleQuote(
    `export PATH=${binPath}:$PATH\n${inner}`,
  )}`;
}

// Single-quote a string for safe use inside another bash single-quoted arg.
// (closes the outer quote, escapes the embedded quote, reopens.)
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// State on the gateway lives in two places that drift out of sync:
//   1. The CLI registry (`openclaw agents list --json`) — what `openclaw
//      agents add/delete` manages. OCCA-provisioned agents created via
//      gateway config.patch DON'T register here, so the CLI lists none of
//      ours even when their state exists on disk.
//   2. The on-disk dirs `~/.openclaw/agents/<id>/` and
//      `~/.openclaw/workspaces/<id>/` — what the OpenClaw dashboard reads
//      and what gateway routing actually walks. These accumulate per-agent
//      sessions, persona files, etc. and orphan readily.
// Reset must sweep BOTH. Always remove `agents/occa-*` and `workspaces/occa-*`
// dirs (the prefix filter protects `main`). CLI delete is best-effort on
// top — useful only if CLI ever starts tracking our agents.
const OPENCLAW_HOME = "/root/.openclaw";

const DRY_RUN_INNER = [
  `set -euo pipefail`,
  // Collate ids from both CLI registry and on-disk dirs.
  `cli_ids=$(openclaw agents list --json | ${REMOTE_JQ_IDS} | grep '^occa-' || true)`,
  `dir_ids=$(ls ${OPENCLAW_HOME}/agents/ 2>/dev/null | grep '^occa-' || true)`,
  `ws_ids=$(ls ${OPENCLAW_HOME}/workspaces/ 2>/dev/null | grep '^occa-' || true)`,
  `printf "%s\\n%s\\n%s\\n" "$cli_ids" "$dir_ids" "$ws_ids" \\`,
  `  | sort -u | grep '^occa-' \\`,
  `  | sed 's/^/CANDIDATE: /' || true`,
].join("\n");

const RESET_INNER = [
  `set -euo pipefail`,
  `cli_ids=$(openclaw agents list --json | ${REMOTE_JQ_IDS} | grep '^occa-' || true)`,
  `dir_ids=$(ls ${OPENCLAW_HOME}/agents/ 2>/dev/null | grep '^occa-' || true)`,
  `ws_ids=$(ls ${OPENCLAW_HOME}/workspaces/ 2>/dev/null | grep '^occa-' || true)`,
  `ids=$(printf "%s\\n%s\\n%s\\n" "$cli_ids" "$dir_ids" "$ws_ids" | sort -u | grep '^occa-' || true)`,
  `if [ -z "$ids" ]; then`,
  `  echo "EMPTY"`,
  `  exit 0`,
  `fi`,
  `echo "$ids" | while read -r id; do`,
  `  [ -z "$id" ] && continue`,
  // Best-effort CLI delete (no-op for orphans that CLI doesn't know about).
  `  openclaw agents delete "$id" --force >/dev/null 2>&1 || true`,
  // Authoritative cleanup: rm both state dirs. `--` guards against any
  // weird id starting with `-`. Safe under the `^occa-` filter.
  `  if rm -rf -- "${OPENCLAW_HOME}/agents/$id" "${OPENCLAW_HOME}/workspaces/$id"; then`,
  `    echo "DELETED: $id"`,
  `  else`,
  `    echo "FAILED: $id"`,
  `  fi`,
  `done`,
].join("\n");

const DRY_RUN_REMOTE_CMD = buildRemoteCmd(DRY_RUN_INNER);
const RESET_REMOTE_CMD = buildRemoteCmd(RESET_INNER);

router.post(
  "/reset-gateway",
  requireAuth,
  requireDevWallet,
  async (req: Request, res: Response) => {
    const dryRun = req.query.dryRun === "true" || req.query.dryRun === "1";

    const host = process.env.OCCA_GATEWAY_SSH_HOST;
    const user = process.env.OCCA_GATEWAY_SSH_USER || "root";
    const keyRaw = process.env.OCCA_GATEWAY_SSH_KEY;
    if (!host || !keyRaw) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.SSH_CONFIG_MISSING,
        detail:
          "OCCA_GATEWAY_SSH_HOST and OCCA_GATEWAY_SSH_KEY must be set in the server env",
      });
      return;
    }
    const keyPath = expandHome(keyRaw);
    const remoteCmd = dryRun ? DRY_RUN_REMOTE_CMD : RESET_REMOTE_CMD;

    try {
      const { stdout, stderr } = await execFileAsync(
        "ssh",
        [
          "-i",
          keyPath,
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          "ConnectTimeout=10",
          `${user}@${host}`,
          remoteCmd,
        ],
        { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      );

      const lines = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      const stripPrefix = (prefix: string) => (line: string) =>
        line.slice(prefix.length).trim();

      const candidates = lines
        .filter((l) => l.startsWith("CANDIDATE: "))
        .map(stripPrefix("CANDIDATE: "));
      const removed = lines
        .filter((l) => l.startsWith("DELETED: "))
        .map(stripPrefix("DELETED: "));
      const failures = lines
        .filter((l) => l.startsWith("FAILED: "))
        .map(stripPrefix("FAILED: "));

      res.json({
        ok: failures.length === 0,
        dryRun,
        target: `${user}@${host}`,
        candidates,
        removed,
        failures,
        stdout,
        stderr,
      });
    } catch (err) {
      const e = err as {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        message?: string;
      };
      res.status(StatusCodes.BAD_GATEWAY).json({
        error: ERROR_CODES.SSH_FAILED,
        detail: e.message ?? "ssh exited non-zero",
        exitCode: e.code,
        stdout: e.stdout,
        stderr: e.stderr,
      });
    }
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
