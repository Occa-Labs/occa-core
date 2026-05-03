import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../../infra/database/client";
import { companies } from "@occa/shared/schema";
import {
  type AgentRole,
  type SkillDTO,
  type SkillFileEntry,
  type SkillSourceType,
} from "@occa/shared/types";
import { requireAuth } from "../../../middleware/auth";
import {
  fetchGithubSkill,
  GithubSkillError,
  parseSkillSource,
} from "../infra/skill-fetch";
import {
  OCCA_DEFAULT_SKILLS,
  ROLE_DEFAULT_SKILLS,
} from "../domain/catalog";
import {
  importSkillBody,
  listSkillsQuery,
  patchSkillBody,
} from "../domain/schemas";
import {
  broadcastSkillToEligibleAgents,
  deleteSkillById,
  findByIdInScope,
  findByKeyInCompany,
  insertSkillReturning,
  listLibraryForCompany,
  updateSkillById,
  type CompanySkillRow,
} from "../repositories/company-skills";

const router: Router = Router();

async function userCompanyId(userId: string): Promise<string | null> {
  const [row] = await db
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
  return row?.id ?? null;
}

function toDTO(row: CompanySkillRow): SkillDTO {
  return {
    id: row.id,
    companyId: row.companyId,
    key: row.key,
    slug: row.slug,
    name: row.name,
    description: row.description,
    markdown: row.markdown,
    sourceType: row.sourceType as SkillSourceType,
    sourceLocator: row.sourceLocator,
    sourceRef: row.sourceRef,
    sourceOwner: row.sourceOwner,
    sourceRepo: row.sourceRepo,
    sourcePath: row.sourcePath,
    fileInventory: (row.fileInventory as SkillFileEntry[]) ?? [],
    allowedRoles: (row.allowedRoles as AgentRole[]) ?? [],
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function dedupeRoles(input: AgentRole[]): AgentRole[] {
  return Array.from(new Set(input));
}

async function loadOwnedSkill(
  userId: string,
  skillId: string,
): Promise<CompanySkillRow | undefined> {
  const companyId = await userCompanyId(userId);
  if (!companyId) return undefined;
  return findByIdInScope({ skillId, companyId });
}

function isBuiltin(row: CompanySkillRow): boolean {
  return row.companyId === null;
}

// Canonical keys (`owner/repo/slug`) that an agent of this role is allowed
// to enable. Combines the OCCA platform defaults (everyone) with the
// role's own catalog from ROLE_DEFAULT_SKILLS. Used to scope an agent's
// "Available skills" panel — without this filter the panel leaks skills
// from other roles (e.g. CTO Advisor showing up under a Head of Editorial
// agent) because the previous `allowed_roles` column filter is a no-op:
// every seeded skill is stored with `allowed_roles=[]` (= "all roles").
function resolveAllowedKeysForRole(role: AgentRole): string[] {
  const sources = [
    ...OCCA_DEFAULT_SKILLS,
    ...(ROLE_DEFAULT_SKILLS[role] ?? []),
  ];
  const keys = sources.map((s) => {
    const parsed = parseSkillSource(s);
    return `${parsed.owner}/${parsed.repo}/${parsed.slug}`;
  });
  return Array.from(new Set(keys));
}

// GET /api/skills?role=<role>
// Without `role`: company library view — every skill that's either an
//   OCCA platform default or in active use by ≥1 agent in this company.
// With `role`: per-agent view — only OCCA defaults + ROLE_DEFAULT_SKILLS
//   for that role. Skills from other roles are hidden so the toggle
//   panel doesn't lie about what the agent can usefully turn on.
router.get("/", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const parsed = listSkillsQuery.safeParse(req.query);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_QUERY, detail: parsed.error.flatten() });
    return;
  }

  const role = parsed.data.role;
  const rows = await listLibraryForCompany({
    companyId,
    occaDefaultSources: OCCA_DEFAULT_SKILLS,
    role,
    roleScopedKeys: role ? resolveAllowedKeysForRole(role) : undefined,
  });
  res.json({ skills: rows.map(toDTO) });
});

// POST /api/skills/import — fetch + upsert a GitHub-sourced skill into the
// company's library. New imports are auto-broadcast to eligible agents
// (so they immediately appear in the library). Re-imports update
// content but don't re-broadcast — manual per-agent disables survive.
router.post("/import", requireAuth, async (req: Request, res: Response) => {
  const parsed = importSkillBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }

  let fetched;
  try {
    fetched = await fetchGithubSkill(parsed.data.source);
  } catch (err) {
    if (err instanceof GithubSkillError) {
      const status =
        err.code === "github_not_found"
          ? 404
          : err.code === "github_rate_limited"
            ? 429
            : err.code === "invalid_source" ||
                err.code === "no_skill_md" ||
                err.code === "invalid_frontmatter"
              ? 400
              : 502;
      res.status(status).json({ error: err.code, message: err.message });
      return;
    }
    throw err;
  }

  const allowedRoles = dedupeRoles(parsed.data.allowedRoles ?? []);
  const existing = await findByKeyInCompany({ companyId, key: fetched.key });

  let row: CompanySkillRow;
  if (existing) {
    const updated = await updateSkillById({
      skillId: existing.id,
      patch: {
        slug: fetched.slug,
        name: fetched.name,
        description: fetched.description,
        markdown: fetched.markdown,
        sourceType: "github",
        sourceLocator: fetched.sourceLocator,
        sourceRef: fetched.sourceRef,
        sourceOwner: fetched.sourceOwner,
        sourceRepo: fetched.sourceRepo,
        sourcePath: fetched.sourcePath,
        fileInventory: fetched.fileInventory,
        allowedRoles,
        metadata: fetched.metadata,
      },
    });
    if (!updated) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    row = updated;
  } else {
    row = await insertSkillReturning({
      companyId,
      key: fetched.key,
      slug: fetched.slug,
      name: fetched.name,
      description: fetched.description,
      markdown: fetched.markdown,
      sourceType: "github",
      sourceLocator: fetched.sourceLocator,
      sourceRef: fetched.sourceRef,
      sourceOwner: fetched.sourceOwner,
      sourceRepo: fetched.sourceRepo,
      sourcePath: fetched.sourcePath,
      fileInventory: fetched.fileInventory,
      allowedRoles,
      metadata: fetched.metadata,
    });
    await broadcastSkillToEligibleAgents({
      companyId,
      skillKey: row.key,
      allowedRoles,
    });
  }

  res.status(StatusCodes.CREATED).json({ skill: toDTO(row) });
});

// GET /api/skills/:id
router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const row = await loadOwnedSkill(req.user!.userId, req.params.id);
  if (!row) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  res.json({ skill: toDTO(row) });
});

// PATCH /api/skills/:id — admin edits allowedRoles
router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const existing = await loadOwnedSkill(req.user!.userId, req.params.id);
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  if (isBuiltin(existing)) {
    res
      .status(StatusCodes.FORBIDDEN)
      .json({ error: ERROR_CODES.BUILTIN_READONLY });
    return;
  }
  const parsed = patchSkillBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }
  if (parsed.data.allowedRoles === undefined) {
    res.json({ skill: toDTO(existing) });
    return;
  }
  const updated = await updateSkillById({
    skillId: existing.id,
    patch: { allowedRoles: dedupeRoles(parsed.data.allowedRoles) },
  });
  if (!updated) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  res.json({ skill: toDTO(updated) });
});

// DELETE /api/skills/:id
router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  const row = await loadOwnedSkill(req.user!.userId, req.params.id);
  if (!row) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  if (isBuiltin(row)) {
    res
      .status(StatusCodes.FORBIDDEN)
      .json({ error: ERROR_CODES.BUILTIN_READONLY });
    return;
  }
  await deleteSkillById(row.id);
  res.json({ ok: true });
});

// GET /api/skills/:id/files/*
// Streams from raw.githubusercontent.com pinned to the skill's commit SHA.
// Whitelisted by fileInventory — requested path must exist in inventory.
router.get(
  "/:id/files/*",
  requireAuth,
  async (req: Request, res: Response) => {
    const row = await loadOwnedSkill(req.user!.userId, req.params.id);
    if (!row) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const requestedPath = (req.params as unknown as { 0?: string })[0] ?? "";
    if (!requestedPath) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.MISSING_PATH });
      return;
    }
    const inventory = (row.fileInventory as SkillFileEntry[]) ?? [];
    if (!inventory.some((e) => e.path === requestedPath)) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.FILE_NOT_IN_INVENTORY });
      return;
    }
    const rawUrl = `https://raw.githubusercontent.com/${row.sourceOwner}/${row.sourceRepo}/${row.sourceRef}/${row.sourcePath}/${requestedPath}`;
    const upstream = await fetch(rawUrl);
    if (!upstream.ok) {
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.UPSTREAM_FAILED, status: upstream.status });
      return;
    }
    const contentType =
      upstream.headers.get("Content-Type") ?? "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  },
);

export default router;
