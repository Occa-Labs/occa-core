// Lazy skill-assignment service.
//
// On agent provision, resolve skill sources for the agent's role from
// `domain/skills/catalog.ts`, ensure each one exists in `companySkills`
// (fetching from GitHub if missing), and write the resulting keys into
// `agents.desiredSkills`. The worker's skill-sync loop installs them.
//
// No bulk pre-seeding — only OCCA platform defaults are seeded at boot
// (services/seed-occa-defaults.ts). Per-role skills are fetched on
// demand the first time an agent of that role is provisioned.

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
} from "../repositories/company-skills";
import {
  getDesiredSkills,
  listAgentsAwaitingSkillInit,
  setDesiredSkills,
} from "../../agents/repositories/agents";
import { enqueueInstalls } from "../../agents/repositories/agent-skill-syncs";
import { childLogger } from "../../../lib/logger";

const log = childLogger("agent-skill-assign");

// Idempotent fetch+insert. Returns the canonical skill key. Race-safe via
// onConflictDoNothing on the unique (company_id, key) constraint — if two
// agents provision at once for the same role, only one fetch wins, both
// end up referencing the same row.
//
// Lookups go through the canonical `key` (owner/repo/slug), NOT
// `sourceLocator`: the locator is rewritten to include the resolved
// commit SHA after fetch, so a `master`-input → `<sha>`-stored mismatch
// would otherwise make the row look "missing" on every boot. The key is
// stable across refs.
//
// Throws on GitHub fetch failure — caller is expected to soft-skip.
export async function ensureCompanySkill(
  source: string,
): Promise<{ key: string }> {
  // Parse first so we can compute the canonical key without a GitHub call
  // — the cached/seeded path skips the network entirely.
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
    // allowedRoles is no longer load-bearing for assignment (the role
    // mapping in domain/skills/catalog.ts is the source of truth).
    // Kept as [] so existing UI badges stay neutral.
    allowedRoles: [],
    metadata: { ...fetched.metadata, builtin: true },
  });

  // Re-read by canonical key (handles race where another caller inserted
  // between our existence check and our insert).
  const after = await findBuiltinByKey(fetched.key);
  if (!after) {
    throw new Error(`ensure_skill_failed: ${source}`);
  }
  return { key: after.key };
}

// Called once at agent birth. Resolves skill sources for the role,
// ensures each is fetched + cached, writes keys into agent.desiredSkills.
//
// Soft-skip on per-skill fetch failure: missing one skill doesn't block
// the rest. The worker's install loop will retry the queued sync; user
// can also retry from the skills panel.
export async function autoAssignSkillsToNewAgent(
  agentId: string,
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

  // Merge with existing desiredSkills (idempotent — agent may already
  // have entries from a previous reprovision).
  const current = await getDesiredSkills(agentId);
  if (current === undefined) return [];

  const merged = Array.from(new Set([...current, ...keys]));
  await setDesiredSkills({ agentId, desiredSkills: merged });

  return keys;
}

// Inserts pending agent_skill_syncs rows so the worker installs them on
// its next tick. Pass-through to the repository — kept here to preserve
// the current public API (callers don't need to know it's now a repo
// call).
export async function enqueueSkillSyncs(input: {
  agentId: string;
  companyId: string;
  skillKeys: string[];
}): Promise<void> {
  return enqueueInstalls(input);
}

// One-shot catch-up for agents that never completed initial auto-assign.
// Mostly defensive — new agents always init via createAgentInternal.
export async function backfillSkillsForAllAgents(): Promise<{
  scanned: number;
  updated: number;
}> {
  const rows = await listAgentsAwaitingSkillInit();
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
