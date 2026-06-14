import type { AgentRole } from "@occa/shared/types";

// Skill source catalog. Lazy-fetch model: skills are NOT pre-seeded for
// every company on boot. Instead:
//
//   - OCCA_DEFAULT_SKILLS — fetched once at boot (small set, every agent
//     installs them). These survive in `company_skills` with company_id=NULL.
//   - ROLE_DEFAULT_SKILLS — fetched on first agent provision per role.
//     A `companySkills` row is upserted (company_id=NULL, race-safe) the
//     first time any agent of that role is provisioned. Subsequent agents
//     of the same role reuse the cached row.
//
// Anti-pattern: do NOT seed all skills at boot. The previous flat
// `BUILTIN_SKILLS` array caused 50+ GitHub fetches on every cold start.
//
// External sources used here are MIT-licensed:
//   - alirezarezvani/claude-skills (c-level-advisor) v2.0.0
//   - Occa-Labs/occa-skills (agent-protocol)
//   - jamditis/claude-skills-journalism (journalism-core skills)
//   - mvanhorn/last30days-skill

// ── OCCA platform defaults ─────────────────────────────────────────────
//
// Installed on EVERY agent regardless of role. Seeded at server boot so
// they're always present. Keep this list very small.
export const OCCA_DEFAULT_SKILLS: string[] = [
  "https://github.com/Occa-Labs/occa-skills/tree/master/agent-protocol",
];

// ── Per-role default skills ────────────────────────────────────────────
//
// Sparse mapping: only roles with curated advisor skills are listed.
// Roles not present here just get OCCA_DEFAULT_SKILLS at provision.
//
// The skill is fetched the first time an agent of a listed role is
// provisioned. Same source used by multiple roles is fetched once and
// reused (matched by source URL in companySkills).
export const ROLE_DEFAULT_SKILLS: Partial<Record<AgentRole, string[]>> = {
  ceo: [
    "https://github.com/alirezarezvani/claude-skills/tree/main/c-level-advisor/ceo-advisor",
  ],
  cfo: [
    "https://github.com/alirezarezvani/claude-skills/tree/main/c-level-advisor/cfo-advisor",
  ],
  cto: [
    "https://github.com/alirezarezvani/claude-skills/tree/main/c-level-advisor/cto-advisor",
  ],
  cmo: [
    "https://github.com/alirezarezvani/claude-skills/tree/main/c-level-advisor/cmo-advisor",
  ],
  coo: [
    "https://github.com/alirezarezvani/claude-skills/tree/main/c-level-advisor/coo-advisor",
  ],
  cpo: [
    "https://github.com/alirezarezvani/claude-skills/tree/main/c-level-advisor/cpo-advisor",
  ],
  cro: [
    "https://github.com/alirezarezvani/claude-skills/tree/main/c-level-advisor/cro-advisor",
  ],
  chro: [
    "https://github.com/alirezarezvani/claude-skills/tree/main/c-level-advisor/chro-advisor",
  ],
  ciso: [
    "https://github.com/alirezarezvani/claude-skills/tree/main/c-level-advisor/ciso-advisor",
  ],
  // Generic journalism craft skills for any News Writer role (jamditis
  // set + last30days recency radar). Company-specific layers (e.g. a
  // crypto-native domain skill) are NOT baked here — the company assigns
  // those to its agents via the CEO skill-library flow, keeping core
  // domain-neutral.
  news_writer: [
    "https://github.com/jamditis/claude-skills-journalism/tree/master/journalism-core/skills/fact-check-workflow",
    "https://github.com/jamditis/claude-skills-journalism/tree/master/journalism-core/skills/ai-writing-detox",
    "https://github.com/jamditis/claude-skills-journalism/tree/master/journalism-core/skills/source-verification",
    "https://github.com/jamditis/claude-skills-journalism/tree/master/journalism-core/skills/editorial-workflow",
    "https://github.com/jamditis/claude-skills-journalism/tree/master/journalism-core/skills/social-media-intelligence",
    "https://github.com/mvanhorn/last30days-skill/tree/main/skills/last30days",
  ],
};

// Resolve all skill sources for an agent of the given role: OCCA defaults
// + role-specific defaults (if any), de-duped.
export function resolveSkillSourcesForRole(role: AgentRole): string[] {
  const roleSpecific = ROLE_DEFAULT_SKILLS[role] ?? [];
  return Array.from(new Set([...OCCA_DEFAULT_SKILLS, ...roleSpecific]));
}
