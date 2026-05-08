import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { LIMITS } from "../../../lib/limits";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { and, count, eq, sql } from "drizzle-orm";
import {
  agentIdentities,
  companies,
  deployments,
  tasks,
} from "@occa/shared/schema";
import type {
  CompanyResponse,
  CompanyStats,
} from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import { requireAuth } from "../../../middleware/auth";
import { toCompanyDTO } from "../domain/dto";
import {
  pauseCompanyBody,
  updateCompanyBody,
} from "../domain/schemas";
import {
  KICKOFF_MAX_DEPLOYMENTS,
  KICKOFF_ROLE_CATALOG,
  TEAM_SIZE_PRESETS,
  startKickoff,
} from "../../../services/kickoff-service";
import { hydrateDeploymentDTOs } from "../../agents/services/deployment-status";
import { KICKOFF_PRESETS, type AgentDTO, type AgentRole } from "@occa/shared/types";
import { CEO_ROLE } from "@occa/shared/role-catalog";
import { childLogger } from "../../../lib/logger";
import {
  findOwnedByIdWithProfile,
  findByIdWithProfile,
  updateCore,
  type CompanyWithProfile,
} from "../repositories/companies";
import { upsert as upsertProfile } from "../repositories/company-profiles";

const log = childLogger("routes:companies");

// Kickoff status SSE polling interval. Tuned for responsive UI without
// hammering the DB.
const KICKOFF_POLL_INTERVAL_MS = 1_500;

const router: Router = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────

async function buildStats(companyId: string): Promise<CompanyStats> {
  const [agentRow] = await db
    .select({ n: count() })
    .from(deployments)
    .where(eq(deployments.companyId, companyId));
  const [taskRow] = await db
    .select({ n: count() })
    .from(tasks)
    .where(eq(tasks.companyId, companyId));
  return {
    agentsCount: Number(agentRow?.n ?? 0),
    tasksCount: Number(taskRow?.n ?? 0),
    // Wired up once company_memory table lands. Returning 0 keeps the UI
    // contract stable today.
    memoryEntriesCount: 0,
  };
}

async function respondWithCompany(
  res: Response,
  loaded: CompanyWithProfile,
  status: number = StatusCodes.OK,
) {
  const stats = await buildStats(loaded.company.id);
  const payload: CompanyResponse = {
    company: toCompanyDTO(loaded.company, loaded.profile),
    stats,
  };
  res.status(status).json(payload);
}

// Profile fields = updateCompanyBody minus `name`. Anything in this set
// belongs in company_profile, not companies.
const PROFILE_FIELDS = new Set<keyof UpdateCompanyBody>([
  "tagline",
  "logoUrl",
  "niche",
  "foundedAt",
  "coverageScope",
  "coverageExcluded",
  "contentPillars",
  "brandVoice",
  "forbiddenWords",
  "mission",
  "vision",
  "targetAudience",
  "usps",
  "coreOffering",
  "serviceCatalog",
  "contactEmail",
  "salesEmail",
  "phone",
  "websiteUrl",
  "blogUrl",
  "newsletterUrl",
  "docsUrl",
  "socialHandles",
  "treasuryAddress",
  "chainsCovered",
]);

type UpdateCompanyBody = z.infer<typeof updateCompanyBody>;

function splitCompanyPatch(patch: UpdateCompanyBody): {
  core: { name?: string };
  profile: Partial<Omit<UpdateCompanyBody, "name">>;
} {
  const core: { name?: string } = {};
  const profile: Partial<Omit<UpdateCompanyBody, "name">> = {};
  if ("name" in patch && patch.name !== undefined) core.name = patch.name;
  for (const key of PROFILE_FIELDS) {
    if (key in patch) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (profile as any)[key] = (patch as any)[key];
    }
  }
  return { core, profile };
}

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /api/companies/:id — full identity + stats. 404 if not owned by caller.
router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const loaded = await findOwnedByIdWithProfile({
    userId,
    companyId: req.params.id,
  });
  if (!loaded) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  await respondWithCompany(res, loaded);
});

// PATCH /api/companies/:id — partial update. Reject when paused.
router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const loaded = await findOwnedByIdWithProfile({
    userId,
    companyId: req.params.id,
  });
  if (!loaded) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  if (loaded.company.pausedAt) {
    res.status(StatusCodes.CONFLICT).json({ error: ERROR_CODES.COMPANY_PAUSED });
    return;
  }

  const parsed = updateCompanyBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }

  const updates = parsed.data;
  if (Object.keys(updates).length === 0) {
    // Nothing to do — return current state instead of touching updated_at.
    await respondWithCompany(res, loaded);
    return;
  }

  const { core, profile } = splitCompanyPatch(updates);
  let nextCompany = loaded.company;
  if (Object.keys(core).length > 0) {
    nextCompany = await updateCore({
      companyId: loaded.company.id,
      patch: core,
    });
  }
  let nextProfile = loaded.profile;
  if (Object.keys(profile).length > 0) {
    nextProfile = await upsertProfile({
      companyId: loaded.company.id,
      patch: profile,
    });
  }

  await respondWithCompany(res, { company: nextCompany, profile: nextProfile });
});

// POST /api/companies/:id/pause — set pakum state.
router.post("/:id/pause", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const loaded = await findOwnedByIdWithProfile({
    userId,
    companyId: req.params.id,
  });
  if (!loaded) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  if (loaded.company.pausedAt) {
    // Already paused — return current state, no-op.
    await respondWithCompany(res, loaded);
    return;
  }

  const parsed = pauseCompanyBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }

  const updated = await updateCore({
    companyId: loaded.company.id,
    patch: {
      pausedAt: new Date(),
      pausedReason: parsed.data.reason ?? null,
    },
  });
  await respondWithCompany(res, { company: updated, profile: loaded.profile });
});

// POST /api/companies/:id/resume — clear pakum state.
router.post("/:id/resume", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const loaded = await findOwnedByIdWithProfile({
    userId,
    companyId: req.params.id,
  });
  if (!loaded) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  if (!loaded.company.pausedAt) {
    // Not paused — return current state, no-op.
    await respondWithCompany(res, loaded);
    return;
  }

  const updated = await updateCore({
    companyId: loaded.company.id,
    patch: {
      pausedAt: null,
      pausedReason: null,
    },
  });
  await respondWithCompany(res, { company: updated, profile: loaded.profile });
});

// ── Kickoff endpoints ────────────────────────────────────────────────────────
//
// Drives the post-onboarding "discovery → bulk deploy → background provision
// → team meeting" flow. /start receives the dialog answers and queues the
// async provisioning. /status streams progress (kickoff state + per-agent
// state) so the UI can render the progress banner without polling.

// Catalog of all deployable roles. Drives the kickoff dialog tag picker —
// returned as a flat list (excluding the always-present CEO) plus the max
// deployment cap. Auth-gated so we don't leak default names publicly.
router.get("/kickoff/roles", requireAuth, (_req: Request, res: Response) => {
  const roles = Object.values(KICKOFF_ROLE_CATALOG)
    .filter((r) => r.key !== CEO_ROLE)
    .map((r) => ({
      key: r.key,
      label: r.label,
      description: r.description,
      category: r.category,
      defaultName: r.defaultName,
    }));
  res.status(StatusCodes.OK).json({ roles, maxDeployments: KICKOFF_MAX_DEPLOYMENTS });
});

const kickoffStartBody = z.object({
  description: z.string().trim().min(1).max(LIMITS.DESCRIPTION_SHORT).nullable().optional(),
  niche: z.string().trim().min(1).max(LIMITS.CATEGORY).nullable().optional(),
  audience: z.string().trim().min(1).max(LIMITS.AUDIENCE).nullable().optional(),
  brandVoice: z.string().trim().min(1).max(LIMITS.DESCRIPTION_SHORT).nullable().optional(),
  contentPillars: z.array(z.string().trim().min(1).max(LIMITS.CATEGORY)).optional(),
  // Either pick a preset (server resolves to role list) or pass an
  // explicit role list. If both are present, `roles` wins.
  preset: z.enum(KICKOFF_PRESETS).optional(),
  roles: z
    .array(
      z.enum(Object.keys(KICKOFF_ROLE_CATALOG) as [AgentRole, ...AgentRole[]]),
    )
    .optional(),
});

router.post(
  "/:id/kickoff/start",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const loaded = await findOwnedByIdWithProfile({
      userId,
      companyId: req.params.id,
    });
    if (!loaded) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    if (loaded.company.pausedAt) {
      res.status(StatusCodes.CONFLICT).json({ error: ERROR_CODES.COMPANY_PAUSED });
      return;
    }

    // Pre-flight: kickoff inserts deployments referencing the CEO by index +
    // expects the company to be on chain. If onboarding's anchor flow
    // hasn't completed, every deployment would land with placeholder PDAs and
    // the batch-anchor button on the FE would silently fail at server
    // verification. Block here with a clear error so the user is sent
    // back to finish anchoring instead.
    const companyAnchored = (() => {
      if (!loaded.company.companyPda) return false;
      try {
        new PublicKey(loaded.company.companyPda);
        return true;
      } catch {
        return false;
      }
    })();
    if (!companyAnchored) {
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({
          error: ERROR_CODES.CHAIN_NOT_ANCHORED,
          detail: "Company is not registered on-chain yet.",
        });
      return;
    }
    const [ceoIdentityRow] = await db
      .select({ identityPda: agentIdentities.identityPda })
      .from(deployments)
      .innerJoin(
        agentIdentities,
        eq(deployments.agentIdentityId, agentIdentities.id),
      )
      .where(
        and(
          eq(deployments.companyId, loaded.company.id),
          eq(deployments.role, CEO_ROLE),
        ),
      )
      .limit(1);
    const ceoAnchored = (() => {
      if (!ceoIdentityRow?.identityPda) return false;
      try {
        new PublicKey(ceoIdentityRow.identityPda);
        return true;
      } catch {
        return false;
      }
    })();
    if (!ceoAnchored) {
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({
          error: ERROR_CODES.CHAIN_NOT_ANCHORED,
          detail: "CEO identity is not registered on-chain yet.",
        });
      return;
    }

    const parsed = kickoffStartBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
      return;
    }
    const body = parsed.data;

    // Resolve roles. Reject CEO from the deploy list — already exists.
    let resolvedRoles: AgentRole[] = body.roles
      ? body.roles
      : body.preset
        ? TEAM_SIZE_PRESETS[body.preset]
        : [];
    resolvedRoles = resolvedRoles.filter((r) => r !== CEO_ROLE);
    if (resolvedRoles.length === 0) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({
          error: ERROR_CODES.NO_ROLES_SELECTED,
          detail: "Pick at least one role to deploy.",
        });
      return;
    }
    if (resolvedRoles.length > KICKOFF_MAX_DEPLOYMENTS) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.TOO_MANY_ROLES,
        detail: `Pick at most ${KICKOFF_MAX_DEPLOYMENTS} deployments.`,
      });
      return;
    }

    try {
      const result = await startKickoff(loaded.company.id, {
        description: body.description ?? null,
        niche: body.niche ?? null,
        audience: body.audience ?? null,
        brandVoice: body.brandVoice ?? null,
        contentPillars: body.contentPillars ?? [],
        rolesToDeploy: resolvedRoles,
      });
      res.status(StatusCodes.ACCEPTED).json({
        ok: true,
        deployedAgentIds: result.deployedAgentIds,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "kickoff_failed";
      const status = message.startsWith("kickoff_already_") ? 409 : 500;
      res.status(status).json({ error: message });
    }
  },
);

// SSE stream — emits one frame on connect (current state) and one per
// status change while the connection is open. Frame shape:
// { kickoffState, agents: [{ id, name, role, provisioningState, error? }] }
router.get(
  "/:id/kickoff/status",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const loaded = await findOwnedByIdWithProfile({
      userId,
      companyId: req.params.id,
    });
    if (!loaded) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const companyId = loaded.company.id;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    let closed = false;
    req.on("close", () => {
      closed = true;
    });

    const emit = (event: string, data: unknown) => {
      if (closed) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const buildFrame = async () => {
      const next = await findByIdWithProfile(companyId);
      if (!next) return null;
      const deploymentRows = await db
        .select()
        .from(deployments)
        .where(eq(deployments.companyId, companyId));
      // hydrateDeploymentDTOs adds runtime state, but the kickoff stream
      // only cares about provisioningState — keep it lean.
      const agentDTOs: AgentDTO[] = await hydrateDeploymentDTOs(deploymentRows);
      return {
        kickoffState: next.company.kickoffState,
        agents: agentDTOs.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          provisioningState: a.provisioningState,
          provisioningError: a.provisioningError,
          externalAgentId: a.externalAgentId,
        })),
      };
    };

    // Initial frame
    const initial = await buildFrame();
    if (initial) {
      emit("status", initial);
    }

    // If we connect AFTER provisioning already finished (e.g. browser
    // refresh while state was already completed), short-circuit straight
    // to done so the client doesn't wait for a state change that will
    // never come.
    if (initial && initial.kickoffState === "completed") {
      emit("done", { kickoffState: initial.kickoffState });
      res.end();
      return;
    }

    // Poll every 1.5s while open. Could move to LISTEN/NOTIFY later for
    // push-based delivery, but polling is fine for this short-lived
    // (max ~90s) flow.
    let lastSerialized = JSON.stringify(initial);
    const interval = setInterval(async () => {
      if (closed) {
        clearInterval(interval);
        return;
      }
      let frame;
      try {
        frame = await buildFrame();
      } catch (err) {
        log.error({ err }, "/kickoff/status buildFrame failed");
        return;
      }
      if (!frame) return;
      const ser = JSON.stringify(frame);
      if (ser === lastSerialized) return;
      lastSerialized = ser;
      emit("status", frame);
      // Stop streaming once kickoff has fully completed — provisioning
      // pass is done (whether or not all deployments succeeded).
      if (frame.kickoffState === "completed") {
        clearInterval(interval);
        emit("done", { kickoffState: frame.kickoffState });
        res.end();
      }
    }, KICKOFF_POLL_INTERVAL_MS);
  },
);

// Reset kickoff to 'not_started'. Used as the escape hatch when a kickoff
// gets stuck (e.g. all deployments failed provisioning, gateway was down).
// Drops every non-CEO agent + every kickoff-tagged task so the user can
// re-pick their team from a clean slate.
router.post(
  "/:id/kickoff/reset",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const loaded = await findOwnedByIdWithProfile({
      userId,
      companyId: req.params.id,
    });
    if (!loaded) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const companyId = loaded.company.id;

    const { tasksDeleted, agentsDeleted } = await db.transaction(async (tx) => {
      // Drop kickoff-tagged tasks (residual from older deployments).
      const { rowCount: tasksRow } = await tx.execute(sql`
        DELETE FROM tasks WHERE company_id = ${companyId} AND 'kickoff' = ANY(tags)
      `);
      // Drop every non-CEO deployment. CEO survives the reset; the user
      // keeps their original gateway pairing. Cascade clears the runtime
      // profile + workspace files + skill syncs via FK; identities
      // survive (they may be redeployed elsewhere).
      const deletedAgents = await tx
        .delete(deployments)
        .where(
          and(
            eq(deployments.companyId, companyId),
            sql`role <> 'ceo'`,
          ),
        )
        .returning({ id: deployments.id });
      await tx
        .update(companies)
        .set({
          kickoffState: "not_started",
          kickoffStartedAt: null,
          kickoffCompletedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, companyId));
      return {
        tasksDeleted: tasksRow ?? 0,
        agentsDeleted: deletedAgents.length,
      };
    });

    res.status(StatusCodes.OK).json({ ok: true, agentsDeleted, tasksDeleted });
  },
);

export default router;
