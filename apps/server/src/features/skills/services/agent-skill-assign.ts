// Lazy skill-assignment service.
//
// On deployment provision, resolve skill sources for the agent's role
// from `domain/skills/catalog.ts`, ensure each one exists in
// `companySkills` (fetching from GitHub if missing), and write the
// resulting keys into `agent_runtime_profile.desiredSkills`. The
// worker's skill-sync loop installs them.
//
// No bulk pre-seeding — only OCCA platform defaults are seeded at boot
// (services/seed-occa-defaults.ts). Per-role skills are fetched on
// demand the first time a deployment of that role is provisioned.

import type { AgentRole } from "@occa/shared/types";
import {
  OCCA_DEFAULT_SKILLS,
  resolveSkillSourcesForRole,
} from "../domain/catalog";
import {
  fetchGithubSkill,
  parseSkillSource,
} from "../infra/skill-fetch";
import {
  findBuiltinByKey,
  insertSkill,
  updateSkillById,
  type CompanySkillRow,
} from "../repositories/company-skills";
import {
  getDesiredSkills,
  listDeploymentsAwaitingSkillInit,
  setDesiredSkills,
} from "../../agents/repositories/agent-runtime-profile";
import { enqueueInstalls } from "../../agents/repositories/deployment-skill-syncs";
import { childLogger } from "../../../lib/logger";

const log = childLogger("agent-skill-assign");

// Idempotent fetch+insert. Returns the canonical skill key. Race-safe via
// onConflictDoNothing on the unique (company_id, key) constraint — if two
// deployments provision at once for the same role, only one fetch wins,
// both end up referencing the same row.
//
// Lookups go through the canonical `key` (owner/repo/slug), NOT
// `sourceLocator`: the locator is rewritten to include the resolved
// commit SHA after fetch, so a `master`-input → `<sha>`-stored mismatch
// would otherwise make the row look "missing" on every boot. The key is
// stable across refs.
//
// Boot-time behaviour: if the builtin already exists, skip GitHub. To
// pull a new revision of an OCCA-shipped default after editing its
// SKILL.md upstream, operators hit POST /api/skills/refresh-defaults
// — see refreshBuiltinSkill below.
//
// Throws on GitHub fetch failure — caller is expected to soft-skip.
export async function ensureCompanySkill(
  source: string,
): Promise<{ key: string }> {
  const parsed = parseSkillSource(source);
  const key = `${parsed.owner}/${parsed.repo}/${parsed.slug}`;

  const existing = await findBuiltinByKey(key);
  if (existing) return { key: existing.key };

  const fetched = await fetchGithubSkill(source);
  await insertSkill({
    companyId: null,
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
    allowedRoles: [],
    metadata: { ...fetched.metadata, builtin: true },
  });

  const after = await findBuiltinByKey(fetched.key);
  if (!after) {
    throw new Error(`ensure_skill_failed: ${source}`);
  }
  return { key: after.key };
}

// On-demand refresh path. Forces a GitHub refetch and updates the
// row in place if the resolved commit SHA differs from the stored
// sourceRef. Returns whether anything actually changed so the caller
// can surface "already up to date" vs "updated to <sha>" in the UI.
//
// Driven by POST /api/skills/:id/refresh (per-skill button) and
// POST /api/skills/refresh-defaults (batch over OCCA_DEFAULT_SKILLS).
// Boot stays cheap because builtins short-circuit in ensureCompanySkill.
export async function refreshSkillRow(args: {
  skill: CompanySkillRow;
}): Promise<{ updated: boolean; sourceRef: string }> {
  // Refresh always resolves the repo's default-branch HEAD. Passing the
  // stored sourceLocator alone would round-trip the previously-pinned
  // commit SHA (we rewrite the URL at first-fetch to embed it) and the
  // diff against args.skill.sourceRef would never report a change.
  const fetched = await fetchGithubSkill(args.skill.sourceLocator, {
    forceDefaultBranch: true,
  });
  if (args.skill.sourceRef === fetched.sourceRef) {
    return { updated: false, sourceRef: args.skill.sourceRef };
  }
  await updateSkillById({
    skillId: args.skill.id,
    patch: {
      slug: fetched.slug,
      name: fetched.name,
      description: fetched.description,
      markdown: fetched.markdown,
      sourceLocator: fetched.sourceLocator,
      sourceRef: fetched.sourceRef,
      sourceOwner: fetched.sourceOwner,
      sourceRepo: fetched.sourceRepo,
      sourcePath: fetched.sourcePath,
      fileInventory: fetched.fileInventory,
      metadata: {
        ...fetched.metadata,
        ...(args.skill.companyId === null ? { builtin: true } : {}),
      },
    },
  });
  return { updated: true, sourceRef: fetched.sourceRef };
}

// Convenience for batch refresh over OCCA_DEFAULT_SKILLS. Re-fetches
// each by source, ensures the row exists (insert) or updates in place
// (refreshSkillRow). Returns per-source status for the UI summary.
export async function refreshBuiltinSkill(source: string): Promise<{
  key: string;
  updated: boolean;
}> {
  const fetched = await fetchGithubSkill(source);
  const existing = await findBuiltinByKey(fetched.key);

  if (!existing) {
    await insertSkill({
      companyId: null,
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
      allowedRoles: [],
      metadata: { ...fetched.metadata, builtin: true },
    });
    return { key: fetched.key, updated: true };
  }

  const result = await refreshSkillRow({ skill: existing });
  return { key: existing.key, updated: result.updated };
}

// Called once at deployment birth. Resolves skill sources for the role,
// ensures each is fetched + cached, writes keys into the runtime
// profile's desiredSkills.
//
// Soft-skip on per-skill fetch failure: missing one skill doesn't block
// the rest. The worker's install loop will retry the queued sync; user
// can also retry from the skills panel.
export async function autoAssignSkillsToNewAgent(
  deploymentId: string,
  role: AgentRole,
  _companyId: string,
): Promise<string[]> {
  const sources = resolveSkillSourcesForRole(role);

  const keys: string[] = [];
  for (const source of sources) {
    try {
      const { key } = await ensureCompanySkill(source);
      keys.push(key);
    } catch (err) {
      log.warn({ err, source, role }, "failed to ensure skill, soft-skipping");
    }
  }

  // Merge with existing desiredSkills (idempotent — deployment may
  // already have entries from a previous reprovision).
  const current = await getDesiredSkills(deploymentId);
  if (current === undefined) return [];

  const merged = Array.from(new Set([...current, ...keys]));
  await setDesiredSkills({ deploymentId, desiredSkills: merged });

  return keys;
}

// Inserts pending deployment_skill_syncs rows so the worker installs
// them on its next tick. Pass-through to the repository — kept here to
// preserve the current public API (callers don't need to know it's now
// a repo call).
export async function enqueueSkillSyncs(input: {
  deploymentId: string;
  companyId: string;
  skillKeys: string[];
}): Promise<void> {
  return enqueueInstalls(input);
}

// One-shot catch-up for deployments that never completed initial
// auto-assign. Mostly defensive — new deployments always init via
// createDeploymentInternal.
export async function backfillSkillsForAllAgents(): Promise<{
  scanned: number;
  updated: number;
}> {
  const rows = await listDeploymentsAwaitingSkillInit();
  let updated = 0;
  for (const row of rows) {
    const keys = await autoAssignSkillsToNewAgent(
      row.id,
      row.role as AgentRole,
      row.companyId,
    );
    if (keys.length > 0) updated++;
  }
  return { scanned: rows.length, updated };
}

export { OCCA_DEFAULT_SKILLS };
