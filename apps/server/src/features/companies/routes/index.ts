import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { count, eq } from "drizzle-orm";
import { companies, deployments, tasks } from "@occa/shared/schema";
import type { CompanyResponse, CompanyStats } from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import { requireAuth } from "../../../middleware/auth";
import { toCompanyDTO } from "../domain/dto";
import {
  createCompanyBody,
  pauseCompanyBody,
  updateCompanyBody,
} from "../domain/schemas";
import {
  findActiveOwnerCompanyWithProfile,
  findOwnedByIdWithProfile,
  insertOwnerCompany,
  updateCore,
  type CompanyWithProfile,
} from "../repositories/companies";
import { PG_ERROR_CODES } from "../../../lib/pg-errors";
import { upsert as upsertProfile } from "../repositories/company-profiles";
import { getCompanyMonthSpendCents } from "../../../services/company-budget";

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
  const budgetSpentCents = await getCompanyMonthSpendCents(companyId);
  return {
    agentsCount: Number(agentRow?.n ?? 0),
    tasksCount: Number(taskRow?.n ?? 0),
    // Wired up once company_memory table lands. Returning 0 keeps the UI
    // contract stable today.
    memoryEntriesCount: 0,
    budgetSpentCents,
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
  core: {
    name?: string;
    monthlyBudgetCents?: number;
    maxReviewRounds?: number;
    researchBudget?: number;
  };
  profile: Partial<
    Omit<
      UpdateCompanyBody,
      "name" | "monthlyBudgetCents" | "maxReviewRounds" | "researchBudget"
    >
  >;
} {
  const core: {
    name?: string;
    monthlyBudgetCents?: number;
    maxReviewRounds?: number;
    researchBudget?: number;
  } = {};
  const profile: Partial<
    Omit<
      UpdateCompanyBody,
      "name" | "monthlyBudgetCents" | "maxReviewRounds" | "researchBudget"
    >
  > = {};
  if ("name" in patch && patch.name !== undefined) core.name = patch.name;
  // monthlyBudgetCents + maxReviewRounds + researchBudget live on the
  // companies row, not company_profile.
  if ("monthlyBudgetCents" in patch && patch.monthlyBudgetCents !== undefined) {
    core.monthlyBudgetCents = patch.monthlyBudgetCents;
  }
  if ("maxReviewRounds" in patch && patch.maxReviewRounds !== undefined) {
    core.maxReviewRounds = patch.maxReviewRounds;
  }
  if ("researchBudget" in patch && patch.researchBudget !== undefined) {
    core.researchBudget = patch.researchBudget;
  }
  for (const key of PROFILE_FIELDS) {
    if (key in patch) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (profile as any)[key] = (patch as any)[key];
    }
  }
  return { core, profile };
}

// ── Routes ──────────────────────────────────────────────────────────────────

// POST /api/companies — create the caller's `user`-kind company. Single-
// field input today (just `name`); profile fields land later via PATCH.
// Enforces the MVP one-wallet-one-company invariant — racing inserts
// surface as a unique-violation that we map to `COMPANY_ALREADY_EXISTS`.
router.post("/", requireAuth, async (req: Request, res: Response) => {
  const parsed = createCompanyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_BODY,
      detail: parsed.error.flatten(),
    });
    return;
  }
  const userId = req.user!.userId;

  // Friendly pre-check — surfaces an existing company without throwing.
  // The unique index below is still the authoritative gate against races.
  const existing = await findActiveOwnerCompanyWithProfile(userId);
  if (existing) {
    res.status(StatusCodes.CONFLICT).json({
      error: ERROR_CODES.COMPANY_ALREADY_EXISTS,
    });
    return;
  }

  let company;
  try {
    company = await insertOwnerCompany({
      userId,
      name: parsed.data.name,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === PG_ERROR_CODES.UNIQUE_VIOLATION) {
      res.status(StatusCodes.CONFLICT).json({
        error: ERROR_CODES.COMPANY_ALREADY_EXISTS,
      });
      return;
    }
    throw err;
  }
  await respondWithCompany(
    res,
    { company, profile: null },
    StatusCodes.CREATED,
  );
});

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


export default router;
