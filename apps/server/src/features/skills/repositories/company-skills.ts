import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  agentRuntimeProfile,
  companySkills,
  deployments,
} from "@occa/shared/schema";
import type { AgentRole } from "@occa/shared/types";
import { db } from "../../../infra/database/client";

export type CompanySkillRow = typeof companySkills.$inferSelect;
export type CompanySkillInsert = typeof companySkills.$inferInsert;

// ── Lookups ──────────────────────────────────────────────────────────────

export async function findBySource(
  source: string,
): Promise<CompanySkillRow | undefined> {
  const [row] = await db
    .select()
    .from(companySkills)
    .where(eq(companySkills.sourceLocator, source))
    .limit(1);
  return row;
}

// Resolve a skill the caller can mutate: must belong to the company OR
// be a platform-wide row (company_id IS NULL). Used by routes/skills.ts
// for PATCH / DELETE / file-stream auth checks.
export async function findByIdInScope(args: {
  skillId: string;
  companyId: string;
}): Promise<CompanySkillRow | undefined> {
  const [row] = await db
    .select()
    .from(companySkills)
    .where(
      and(
        eq(companySkills.id, args.skillId),
        sql`(${companySkills.companyId} = ${args.companyId} OR ${companySkills.companyId} IS NULL)`,
      ),
    )
    .limit(1);
  return row;
}

// Find an existing per-company skill row by source URL, for the
// import-or-update flow (POST /api/skills/import).
export async function findCompanyImportBySource(args: {
  companyId: string;
  source: string;
}): Promise<CompanySkillRow | undefined> {
  const [row] = await db
    .select()
    .from(companySkills)
    .where(
      and(
        eq(companySkills.companyId, args.companyId),
        eq(companySkills.sourceLocator, args.source),
      ),
    )
    .limit(1);
  return row;
}

// Find by (companyId, key) — used by the import upsert path where
// a slug-derived `key` is the canonical identity (URL canonicalization
// can produce different sourceLocators for the same skill).
export async function findByKeyInCompany(args: {
  companyId: string;
  key: string;
}): Promise<CompanySkillRow | undefined> {
  const [row] = await db
    .select()
    .from(companySkills)
    .where(
      and(
        eq(companySkills.companyId, args.companyId),
        eq(companySkills.key, args.key),
      ),
    )
    .limit(1);
  return row;
}

// Find a platform built-in (company_id IS NULL) by its canonical key.
// Used by the lazy-skill-fetch flow to detect whether a default has
// already been seeded — robust against URL canonicalization (sourceLocator
// changes between input "tree/master/..." and stored "tree/<sha>/...").
export async function findBuiltinByKey(
  key: string,
): Promise<CompanySkillRow | undefined> {
  const [row] = await db
    .select()
    .from(companySkills)
    .where(and(isNull(companySkills.companyId), eq(companySkills.key, key)))
    .limit(1);
  return row;
}

// ── Library listing ──────────────────────────────────────────────────────

// Library listing with two modes:
//
//   Without `roleScopedKeys` — company library view. Returns OCCA platform
//     defaults plus any skill that's referenced by ≥1 agent in this
//     company. Imported/cached skills nobody has assigned stay hidden.
//
//   With `roleScopedKeys` — per-agent view. Returns ONLY skills whose
//     canonical `key` (owner/repo/slug) is in the allowed set the caller
//     resolved from ROLE_DEFAULT_SKILLS + OCCA defaults. Used to scope
//     an agent's "Available skills" toggle panel so it doesn't surface
//     skills from other roles.
//
// Uses Drizzle's query builder (not raw `db.execute`) so timestamp /
// camelCase hydration follows the schema. A previous raw-SQL version
// returned snake_case columns under a lying `<CompanySkillRow>` cast,
// which crashed `toDTO` on `row.createdAt.toISOString()`.
//
// `role` is accepted for back-compat but no longer load-bearing — the
// underlying `allowed_roles` column is always `[]` for seeded skills,
// so the column-based filter is a no-op. New callers should use
// `roleScopedKeys` instead.
export async function listLibraryForCompany(args: {
  companyId: string;
  occaDefaultSources: readonly string[];
  role?: AgentRole;
  roleScopedKeys?: string[];
}): Promise<CompanySkillRow[]> {
  const scopeFilter = or(
    eq(companySkills.companyId, args.companyId),
    isNull(companySkills.companyId),
  );

  let visibilityFilter;
  if (args.roleScopedKeys !== undefined) {
    // Per-agent view. A skill is visible to a role two ways:
    //   1. its key is in the static catalog allow-list (`roleScopedKeys`)
    //      — OCCA defaults + ROLE_DEFAULT_SKILLS.
    //   2. it's an imported skill whose `allowed_roles` column explicitly
    //      lists this role — the static catalog can't know user imports.
    // inArray on `[]` emits invalid `IN ()`, so guard with a sentinel.
    const staticMatch =
      args.roleScopedKeys.length > 0
        ? inArray(companySkills.key, args.roleScopedKeys)
        : sql`false`;
    const roleAllowed = args.role
      ? sql`${args.role} = ANY(${companySkills.allowedRoles})`
      : sql`false`;
    visibilityFilter = or(staticMatch, roleAllowed);
  } else {
    // Company library view: every custom import (company-scoped) is always
    // visible — user deliberately imported it, expects to see it. Builtin
    // OCCA defaults (companyId IS NULL) still gated to platform defaults or
    // currently-used keys so the listing doesn't leak unrelated builtins.
    const usedKeys = db
      .select({
        key: sql<string>`DISTINCT unnest(${agentRuntimeProfile.desiredSkills})`,
      })
      .from(agentRuntimeProfile)
      .where(eq(agentRuntimeProfile.companyId, args.companyId));
    const defaultMatch =
      args.occaDefaultSources.length > 0
        ? inArray(
            companySkills.sourceLocator,
            args.occaDefaultSources as string[],
          )
        : sql`false`;
    const builtinShown = and(
      isNull(companySkills.companyId),
      or(defaultMatch, inArray(companySkills.key, usedKeys)),
    );
    const customImport = eq(companySkills.companyId, args.companyId);
    visibilityFilter = or(builtinShown, customImport);
  }

  return db
    .select()
    .from(companySkills)
    .where(and(scopeFilter, visibilityFilter))
    .orderBy(desc(companySkills.createdAt));
}

// ── Mutations ────────────────────────────────────────────────────────────

// Idempotent insert — onConflictDoNothing on the unique key constraint.
// Returns nothing; caller refetches via findBySource for the canonical row.
export async function insertSkill(values: CompanySkillInsert): Promise<void> {
  await db.insert(companySkills).values(values).onConflictDoNothing();
}

export async function insertSkillReturning(
  values: CompanySkillInsert,
): Promise<CompanySkillRow> {
  const [row] = await db.insert(companySkills).values(values).returning();
  return row;
}

export async function updateSkillById(args: {
  skillId: string;
  patch: Partial<CompanySkillInsert>;
}): Promise<CompanySkillRow | undefined> {
  const [row] = await db
    .update(companySkills)
    .set({ ...args.patch, updatedAt: new Date() })
    .where(eq(companySkills.id, args.skillId))
    .returning();
  return row;
}

export async function deleteSkillById(skillId: string): Promise<void> {
  await db.delete(companySkills).where(eq(companySkills.id, skillId));
}

// Auto-broadcast a newly imported skill to every eligible deployment in
// the company. Runs only on first-time insert — re-import (update) does
// not re-add, so manual per-deployment disables survive re-imports.
// Role gate: empty allowedRoles = all roles eligible. Reads `role` from
// `deployments` and `desiredSkills` from the runtime profile via JOIN;
// writes go to the runtime profile.
export async function broadcastSkillToEligibleAgents(args: {
  companyId: string;
  skillKey: string;
  allowedRoles: AgentRole[];
}): Promise<void> {
  const rows = await db
    .select({
      deploymentId: deployments.id,
      role: deployments.role,
      desiredSkills: agentRuntimeProfile.desiredSkills,
    })
    .from(deployments)
    .innerJoin(
      agentRuntimeProfile,
      eq(agentRuntimeProfile.deploymentId, deployments.id),
    )
    .where(eq(deployments.companyId, args.companyId));
  const eligible = rows.filter(
    (a) =>
      (args.allowedRoles.length === 0 || args.allowedRoles.includes(a.role)) &&
      !a.desiredSkills.includes(args.skillKey),
  );
  if (eligible.length === 0) return;
  await Promise.all(
    eligible.map((a) =>
      db
        .update(agentRuntimeProfile)
        .set({
          desiredSkills: [...a.desiredSkills, args.skillKey],
          updatedAt: new Date(),
        })
        .where(eq(agentRuntimeProfile.deploymentId, a.deploymentId)),
    ),
  );
}

// Suppress unused-import warning when role filter is absent.
export type { AgentRole };
// `isNull` re-export so callers that need company-wide queries can build
// composable conditions without re-importing from drizzle-orm.
export { isNull };
