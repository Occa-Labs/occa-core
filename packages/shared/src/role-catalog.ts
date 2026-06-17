// Canonical role catalog. Single source of truth for role definitions
// across server (kickoff dialog, workspace templates, hire prompts) and web
// (Hire modal autocomplete, sidebar sort). When a role is added/renamed,
// edit this file and only this file — every other site derives from it.
//
// `key` doubles as the slug stored in `agents.role` (open-vocab regex
// `[a-z0-9_-]+`). User-created custom roles bypass the catalog entirely
// and fall through to default behavior at every consumer.

import type { AgentRole } from "./types";

export type RoleCategory =
  | "c_suite"
  | "leadership"
  | "engineering"
  | "product_design"
  | "marketing_growth"
  | "editorial_content"
  | "operations_admin"
  | "sales_success"
  | "data_research"
  | "web3";

// Org-chart tier for the hierarchical agent system. Drives delegation rules:
// `ceo` routes to heads + direct reports; `head` routes to its own
// specialists; `specialist` and `direct_report` cannot delegate further.
// `category` stays for seating + sidebar UI; `tier` is the runtime invariant.
export type RoleTier = "ceo" | "head" | "specialist" | "direct_report";

// Where this role's hire normally sits in the office. Maps to a desk pool
// in `seating.ts`. Most roles inherit zone from `category`; overrides exist
// for heads (head_engineering wants the engineering pit, not a separate
// "leadership" zone) and for category boundaries (community_manager is
// web3 by category, sits with other web3 roles).
import type { SeatingZone } from "./seating";

export interface RoleDefinition {
  key: AgentRole;
  label: string;
  description: string;
  category: RoleCategory;
  defaultName: string;
  seatingZoneOverride?: SeatingZone;
  // Org-chart tier — see RoleTier docs.
  tier: RoleTier;
  // Allow-list of roles this role may delegate to. Empty for specialists,
  // direct reports, and any inactive opt-in role. Encodes the default
  // 35-persona active org chart from hierarchical-agent-system-design §8.
  manages: readonly AgentRole[];
}

// Role declarations. Order matters — drives the dropdown ordering on the
// Hire modal and the sidebar sort.
export const ROLE_CATALOG: readonly RoleDefinition[] = [
  // ── C-Suite ────────────────────────────────────────────────────────────
  // CEO is the only `tier:"ceo"` entry; `manages` lists the active default
  // org chart (5 heads + 3 direct reports). All other C-suite roles are
  // opt-in alternative heads with empty `manages` until activated. CISO is
  // special-cased to `specialist` per design §8 (parked under Engineering).
  {
    key: "ceo",
    label: "CEO",
    description: "Top-level strategy + delegation",
    category: "c_suite",
    defaultName: "CEO",
    tier: "ceo",
    manages: [
      "head_research",
      "head_marketing",
      "head_design",
      "head_engineering",
      "head_community",
      "chief_of_staff",
      "finance_lead",
      "legal_counsel",
    ],
  },
  { key: "cto", label: "CTO", description: "Owns tech direction, research depth, framework decisions", category: "c_suite", defaultName: "Lin Hayashi", seatingZoneOverride: "engineering", tier: "head", manages: [] },
  { key: "cmo", label: "CMO", description: "Brand, distribution, growth, narrative", category: "c_suite", defaultName: "Kira Voss", seatingZoneOverride: "marketing_growth", tier: "head", manages: [] },
  { key: "coo", label: "COO", description: "Day-to-day operations, vendor + delivery ops", category: "c_suite", defaultName: "Sasha Reyes", tier: "head", manages: [] },
  { key: "cfo", label: "CFO", description: "Finance, treasury, runway, fundraising support", category: "c_suite", defaultName: "Hadi Tanaka", tier: "head", manages: [] },
  { key: "cpo", label: "CPO", description: "Product strategy, roadmap, prioritisation", category: "c_suite", defaultName: "Priya Menon", seatingZoneOverride: "product_design", tier: "head", manages: [] },
  { key: "cro", label: "CRO", description: "Revenue, pipeline, sales + partnerships top-line", category: "c_suite", defaultName: "Marco Vega", tier: "head", manages: [] },
  { key: "cco", label: "CCO — Communications", description: "External comms, PR, exec voice, crisis", category: "c_suite", defaultName: "Eliana Cruz", seatingZoneOverride: "marketing_growth", tier: "head", manages: [] },
  { key: "chro", label: "CHRO / Chief People", description: "People strategy, culture, comp, hiring system", category: "c_suite", defaultName: "Yuki Bauer", seatingZoneOverride: "operations_admin", tier: "head", manages: [] },
  { key: "ciso", label: "CISO", description: "Security strategy, compliance posture, incident response", category: "c_suite", defaultName: "Asher Vinh", seatingZoneOverride: "engineering", tier: "specialist", manages: [] },

  // ── Heads / VPs ────────────────────────────────────────────────────────
  // All sit with their dept (overridden) so the floor stays department-coherent.
  // Five heads in the active default (research/marketing/design/engineering/
  // community) carry populated `manages`; the rest are opt-in alternatives
  // and start empty. head_marketing absorbs editorial + growth per design §8.
  {
    key: "head_engineering",
    label: "Head of Engineering",
    description: "Eng org, delivery cadence, technical recruiting",
    category: "leadership",
    defaultName: "Aren Patel",
    seatingZoneOverride: "engineering",
    tier: "head",
    manages: [
      "senior_engineer",
      "frontend_engineer",
      "backend_engineer",
      "devops_engineer",
      "ml_engineer",
      "smart_contract_auditor",
      "solana_engineer",
      "solidity_engineer",
      "ciso",
      "product_manager",
    ],
  },
  { key: "head_product", label: "Head of Product", description: "Product discovery, specs, cross-functional alignment", category: "leadership", defaultName: "Naomi Lee", seatingZoneOverride: "product_design", tier: "head", manages: [] },
  {
    key: "head_design",
    label: "Head of Design",
    description: "Brand system, visual identity, design ops",
    category: "leadership",
    defaultName: "Aiko Tan",
    seatingZoneOverride: "product_design",
    tier: "head",
    manages: ["brand_designer", "motion_designer", "product_designer", "ux_researcher"],
  },
  {
    key: "head_marketing",
    label: "Head of Marketing",
    description: "Marketing org, channel mix, positioning",
    category: "leadership",
    defaultName: "Jonas Weber",
    seatingZoneOverride: "marketing_growth",
    tier: "head",
    manages: [
      "senior_writer",
      "managing_editor",
      "copywriter",
      "seo_specialist",
      "social_media_manager",
      "growth_marketer",
      "brand_manager",
      "pr_manager",
    ],
  },
  { key: "head_growth", label: "Head of Growth", description: "Acquisition, retention, paid + organic experiments", category: "leadership", defaultName: "Riley Okafor", seatingZoneOverride: "marketing_growth", tier: "head", manages: [] },
  {
    key: "head_research",
    label: "Head of Research",
    description: "Deep research, market intel, thesis dev",
    category: "leadership",
    defaultName: "Mira Chen",
    seatingZoneOverride: "data_research",
    tier: "head",
    manages: ["market_researcher", "onchain_analyst", "data_analyst", "tokenomics_designer"],
  },
  {
    key: "head_editorial",
    label: "Head of Editorial",
    description: "Content slate, voice, publishing cadence, holds the publish gate",
    category: "leadership",
    defaultName: "Theo Marsh",
    seatingZoneOverride: "editorial_content",
    tier: "head",
    manages: ["news_writer", "markets_reporter", "verification_editor", "social_media_editor", "seo_editor"],
  },
  {
    key: "head_community",
    label: "Head of Community",
    description: "Community ops, advocate program, moderation",
    category: "leadership",
    defaultName: "Noor Aziz",
    seatingZoneOverride: "web3",
    tier: "head",
    manages: ["community_manager", "customer_success"],
  },
  { key: "head_partnerships", label: "Head of Partnerships / BD", description: "Ecosystem deals, integrations, co-marketing", category: "leadership", defaultName: "Devon Park", seatingZoneOverride: "marketing_growth", tier: "head", manages: [] },
  { key: "head_people", label: "Head of People", description: "Hiring, onboarding, culture rituals", category: "leadership", defaultName: "Adaeze Obi", seatingZoneOverride: "operations_admin", tier: "head", manages: [] },

  // ── Engineering ────────────────────────────────────────────────────────
  { key: "senior_engineer", label: "Senior Engineer", description: "Generalist senior IC — ships features end-to-end", category: "engineering", defaultName: "Felix Romano", tier: "specialist", manages: [] },
  { key: "frontend_engineer", label: "Frontend Engineer", description: "React/UI specialist, interaction polish", category: "engineering", defaultName: "Sora Tanigawa", tier: "specialist", manages: [] },
  { key: "backend_engineer", label: "Backend Engineer", description: "APIs, data layer, services, reliability", category: "engineering", defaultName: "Ivan Petrov", tier: "specialist", manages: [] },
  { key: "ml_engineer", label: "ML / AI Engineer", description: "Model integrations, prompt systems, RAG, evals", category: "engineering", defaultName: "Anika Roy", tier: "specialist", manages: [] },
  { key: "devops_engineer", label: "DevOps / SRE", description: "Infra, CI/CD, observability, on-call", category: "engineering", defaultName: "Kenji Otsuka", tier: "specialist", manages: [] },

  // ── Product / Design ───────────────────────────────────────────────────
  { key: "product_manager", label: "Product Manager", description: "Specs, prioritisation, customer interviews", category: "product_design", defaultName: "Hana Kowalski", tier: "specialist", manages: [] },
  { key: "product_designer", label: "Product Designer", description: "End-to-end product flows, interaction + visual", category: "product_design", defaultName: "Lucia Ferraro", tier: "specialist", manages: [] },
  { key: "brand_designer", label: "Brand Designer", description: "Identity systems, brand collateral, type", category: "product_design", defaultName: "Tomás Gallardo", tier: "specialist", manages: [] },
  { key: "motion_designer", label: "Motion Designer", description: "Animations, video, interaction motion", category: "product_design", defaultName: "Ines Lemaire", tier: "specialist", manages: [] },

  // ── Marketing / Growth ─────────────────────────────────────────────────
  { key: "growth_marketer", label: "Growth Marketer", description: "Acquisition experiments, conversion funnels", category: "marketing_growth", defaultName: "Maya Goldberg", tier: "specialist", manages: [] },
  { key: "social_media_manager", label: "Social Media Manager", description: "Twitter/X, LinkedIn, channel narrative", category: "marketing_growth", defaultName: "Sami Ekstrand", tier: "specialist", manages: [] },
  { key: "seo_specialist", label: "SEO Specialist", description: "Organic search, technical SEO, content briefs", category: "marketing_growth", defaultName: "Roshan Iyer", tier: "specialist", manages: [] },
  { key: "pr_manager", label: "PR Manager", description: "Press relationships, briefings, media kit", category: "marketing_growth", defaultName: "Camille Dubois", tier: "specialist", manages: [] },
  { key: "brand_manager", label: "Brand Manager", description: "Brand consistency, campaign management", category: "marketing_growth", defaultName: "Junko Sato", tier: "specialist", manages: [] },

  // ── Editorial / Content ────────────────────────────────────────────────
  { key: "managing_editor", label: "Managing Editor", description: "Editorial calendar, copy review, fact checks", category: "editorial_content", defaultName: "Lior Stern", tier: "specialist", manages: [] },
  { key: "senior_writer", label: "Senior Writer", description: "Long-form, opinion, deep dives", category: "editorial_content", defaultName: "Faye Eriksson", tier: "specialist", manages: [] },
  { key: "news_writer", label: "News Writer", description: "Fast, factual news writing on a daily cadence", category: "editorial_content", defaultName: "Juno Vale", tier: "specialist", manages: [] },
  { key: "markets_reporter", label: "Markets Reporter", description: "Markets + on-chain data reporting — reports the numbers, not the prediction", category: "editorial_content", defaultName: "Soren Hale", tier: "specialist", manages: [] },
  { key: "verification_editor", label: "Verification Editor", description: "Re-checks every source and claim against primary sources before publish", category: "editorial_content", defaultName: "Anika Roth", tier: "specialist", manages: [] },
  { key: "social_media_editor", label: "Social Media Editor", description: "Distributes published pieces across X and channels in the newsroom voice", category: "editorial_content", defaultName: "Kaia Vale", tier: "specialist", manages: [] },
  { key: "seo_editor", label: "SEO Editor", description: "Shapes each piece for search discovery and ranking — headlines, structure, briefs", category: "editorial_content", defaultName: "Priya Anand", tier: "specialist", manages: [] },
  { key: "copywriter", label: "Copywriter", description: "Short-form copy, landing pages, emails", category: "editorial_content", defaultName: "Owen Hatcher", tier: "specialist", manages: [] },

  // ── Operations / Admin ────────────────────────────────────────────────
  // chief_of_staff / finance_lead / legal_counsel sit directly under CEO
  // (no Head between them and the top); modeled as `direct_report` tier
  // so they accept tasks but cannot delegate further.
  { key: "chief_of_staff", label: "Chief of Staff", description: "Exec leverage, cross-team alignment, special projects", category: "operations_admin", defaultName: "Selene Park", tier: "direct_report", manages: [] },
  { key: "people_ops", label: "People Ops", description: "Onboarding, comp ops, HRIS, policy", category: "operations_admin", defaultName: "Mateo Alvarez", tier: "specialist", manages: [] },
  { key: "finance_lead", label: "Finance Lead", description: "Bookkeeping, AP/AR, investor reporting", category: "operations_admin", defaultName: "Ravi Khurana", tier: "direct_report", manages: [] },
  { key: "legal_counsel", label: "Legal Counsel", description: "Contracts, compliance, IP, regulatory", category: "operations_admin", defaultName: "Astrid Halvorsen", tier: "direct_report", manages: [] },
  { key: "project_manager", label: "Project Manager", description: "Cross-functional delivery, timelines, risk", category: "operations_admin", defaultName: "Bilal Hossain", tier: "specialist", manages: [] },

  // ── Sales / CS ────────────────────────────────────────────────────────
  { key: "account_executive", label: "Account Executive", description: "Closes deals, manages pipeline + named accounts", category: "sales_success", defaultName: "Helena Baros", tier: "specialist", manages: [] },
  { key: "sdr", label: "Sales Development Rep", description: "Outbound prospecting, qualifying, booking demos", category: "sales_success", defaultName: "Quentin Clarke", tier: "specialist", manages: [] },
  { key: "customer_success", label: "Customer Success Manager", description: "Onboarding, expansion, churn prevention", category: "sales_success", defaultName: "Pilar Cortes", tier: "specialist", manages: [] },

  // ── Data / Research ───────────────────────────────────────────────────
  { key: "data_analyst", label: "Data Analyst", description: "Dashboards, deep-dives, growth analysis", category: "data_research", defaultName: "Toma Ishikawa", tier: "specialist", manages: [] },
  { key: "ux_researcher", label: "UX Researcher", description: "Customer interviews, usability, jobs-to-be-done", category: "data_research", defaultName: "Greta Lindholm", tier: "specialist", manages: [] },
  { key: "market_researcher", label: "Market Researcher", description: "Competitive intel, sizing, segmentation", category: "data_research", defaultName: "Idris Mansour", tier: "specialist", manages: [] },

  // ── Web3 Specialty ────────────────────────────────────────────────────
  { key: "solidity_engineer", label: "Solidity Engineer", description: "EVM contracts, audits, gas optimisation", category: "web3", defaultName: "Vlad Cojocaru", tier: "specialist", manages: [] },
  { key: "solana_engineer", label: "Solana Engineer", description: "Anchor programs, SPL tokens, on-chain ops", category: "web3", defaultName: "Diego Salinas", tier: "specialist", manages: [] },
  { key: "onchain_analyst", label: "On-chain Analyst", description: "Wallet flows, protocol metrics, narrative trades", category: "web3", defaultName: "Sana Khalil", tier: "specialist", manages: [] },
  { key: "tokenomics_designer", label: "Tokenomics Designer", description: "Token model, incentives, liquidity mechanics", category: "web3", defaultName: "Eitan Halevi", tier: "specialist", manages: [] },
  { key: "smart_contract_auditor", label: "Smart Contract Auditor", description: "Security review, fuzzing, formal verification", category: "web3", defaultName: "Linnea Holm", tier: "specialist", manages: [] },
  { key: "community_manager", label: "Community Manager", description: "Discord/Telegram daily ops, mods, events", category: "web3", defaultName: "Kofi Mensah", tier: "specialist", manages: [] },
];

const CATALOG_BY_KEY: Record<AgentRole, RoleDefinition> = Object.fromEntries(
  ROLE_CATALOG.map((r) => [r.key, r]),
);

export function getRoleDefinition(role: AgentRole): RoleDefinition | undefined {
  return CATALOG_BY_KEY[role];
}

// Title-case slug for unknown / custom roles ("head-of-design" → "Head Of Design").
export function roleLabelFor(role: AgentRole): string {
  const def = CATALOG_BY_KEY[role];
  if (def) return def.label;
  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// Set of all known role keys. Used by workspace-templates to decide whether
// to look for a role-specific template directory or skip straight to default/.
export const KNOWN_ROLES: ReadonlySet<AgentRole> = new Set(
  ROLE_CATALOG.map((r) => r.key),
);

// C-suite roles are singletons per company — the Hire dialog disables them
// once filled. Every role in `c_suite` category counts.
export const CSUITE_ROLES: ReadonlySet<AgentRole> = new Set(
  ROLE_CATALOG.filter((r) => r.category === "c_suite").map((r) => r.key),
);

// Ordered list of role keys. Drives Hire modal autocomplete + sidebar sort.
// Typed as a non-empty tuple so consumers using `z.enum(ROLE_ORDER)` get
// the literal-union types they need.
export const ROLE_ORDER = ROLE_CATALOG.map((r) => r.key) as [
  AgentRole,
  ...AgentRole[],
];

// Backwards-compat alias. Older code (z.enum(AGENT_ROLES), skill library
// filter) imports this name; new code should prefer ROLE_ORDER.
export const AGENT_ROLES = ROLE_ORDER;

// Special role slugs the platform treats as singletons / hard-coded
// invariants. Imported by call sites that need to compare or filter on
// the slug — never write `"ceo"` as a string literal in app code.
export const CEO_ROLE: AgentRole = "ceo";

// Org-chart tier lookup. Returns undefined for unknown / custom roles —
// callers must decide their default behavior (typically: treat as specialist
// with no delegation rights).
export function getTier(role: AgentRole): RoleTier | undefined {
  return CATALOG_BY_KEY[role]?.tier;
}

// Role-pair allow-list check used by DELEGATE handler. Encodes the canonical
// hierarchy: CEO → its heads + direct reports; Head → its specialists;
// specialists / direct reports / unknowns cannot delegate.
//
// Returns false on unknown roles (fail-closed). Custom roles outside the
// catalog therefore can't delegate at all until added to the registry.
export function canManage(parentRole: AgentRole, childRole: AgentRole): boolean {
  return CATALOG_BY_KEY[parentRole]?.manages.includes(childRole) ?? false;
}

// Specialists and direct reports CANNOT delegate further regardless of
// `manages` (industry best practice from design §7: prevents infinite loops).
// Use as a fast first gate before consulting the per-pair allow-list.
export function canDelegate(role: AgentRole): boolean {
  const tier = CATALOG_BY_KEY[role]?.tier;
  return tier === "ceo" || tier === "head";
}

// List of roles a given parent may delegate to. Empty array for non-delegating
// tiers and unknown roles. Used to inject the routing-options block into the
// CEO / Head wake prompt.
export function getManagedRoles(role: AgentRole): readonly AgentRole[] {
  return CATALOG_BY_KEY[role]?.manages ?? [];
}

// Reverse lookup of `manages`: returns the role that canonically manages
// `role` per the catalog. Used by deployment auto-resolve to pick the right
// parent at deploy time (e.g. senior_writer → head_marketing), and by the
// reparent post-hook when a new head lands and any specialist whose
// canonical parent is that head should slide under it.
//
// Returns undefined for:
//   • CEO (no canonical parent — top of the chart)
//   • Roles unknown to the catalog (custom slugs)
//   • Roles listed in zero `manages` arrays (opt-in heads with empty
//     allow-lists, or specialists not yet wired into a head's lineup)
//
// Built lazily on first call and memoised — the catalog is static at
// module-load so the map only needs one pass.
let CANONICAL_PARENT_BY_ROLE: Map<AgentRole, AgentRole> | null = null;
function buildCanonicalParentIndex(): Map<AgentRole, AgentRole> {
  const idx = new Map<AgentRole, AgentRole>();
  for (const def of ROLE_CATALOG) {
    for (const child of def.manages) {
      // First-writer-wins. If a child role appears in multiple `manages`
      // arrays (rare but possible), the earlier catalog entry takes
      // precedence — deterministic per `ROLE_CATALOG` declaration order.
      if (!idx.has(child)) idx.set(child, def.key);
    }
  }
  return idx;
}
export function findCanonicalParentRole(
  role: AgentRole,
): AgentRole | undefined {
  if (!CANONICAL_PARENT_BY_ROLE) {
    CANONICAL_PARENT_BY_ROLE = buildCanonicalParentIndex();
  }
  return CANONICAL_PARENT_BY_ROLE.get(role);
}
