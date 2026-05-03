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
}

// Role declarations. Order matters — drives the dropdown ordering on the
// Hire modal and the sidebar sort.
export const ROLE_CATALOG: readonly RoleDefinition[] = [
  // ── C-Suite ────────────────────────────────────────────────────────────
  { key: "ceo", label: "CEO", description: "Top-level strategy + delegation", category: "c_suite", defaultName: "CEO" },
  { key: "cto", label: "CTO", description: "Owns tech direction, research depth, framework decisions", category: "c_suite", defaultName: "Lin Hayashi", seatingZoneOverride: "engineering" },
  { key: "cmo", label: "CMO", description: "Brand, distribution, growth, narrative", category: "c_suite", defaultName: "Kira Voss", seatingZoneOverride: "marketing_growth" },
  { key: "coo", label: "COO", description: "Day-to-day operations, vendor + delivery ops", category: "c_suite", defaultName: "Sasha Reyes" },
  { key: "cfo", label: "CFO", description: "Finance, treasury, runway, fundraising support", category: "c_suite", defaultName: "Hadi Tanaka" },
  { key: "cpo", label: "CPO", description: "Product strategy, roadmap, prioritisation", category: "c_suite", defaultName: "Priya Menon", seatingZoneOverride: "product_design" },
  { key: "cro", label: "CRO", description: "Revenue, pipeline, sales + partnerships top-line", category: "c_suite", defaultName: "Marco Vega" },
  { key: "cco", label: "CCO — Communications", description: "External comms, PR, exec voice, crisis", category: "c_suite", defaultName: "Eliana Cruz", seatingZoneOverride: "marketing_growth" },
  { key: "chro", label: "CHRO / Chief People", description: "People strategy, culture, comp, hiring system", category: "c_suite", defaultName: "Yuki Bauer", seatingZoneOverride: "operations_admin" },
  { key: "ciso", label: "CISO", description: "Security strategy, compliance posture, incident response", category: "c_suite", defaultName: "Asher Vinh", seatingZoneOverride: "engineering" },

  // ── Heads / VPs ────────────────────────────────────────────────────────
  // All sit with their dept (overridden) so the floor stays department-coherent.
  { key: "head_engineering", label: "Head of Engineering", description: "Eng org, delivery cadence, technical recruiting", category: "leadership", defaultName: "Aren Patel", seatingZoneOverride: "engineering" },
  { key: "head_product", label: "Head of Product", description: "Product discovery, specs, cross-functional alignment", category: "leadership", defaultName: "Naomi Lee", seatingZoneOverride: "product_design" },
  { key: "head_design", label: "Head of Design", description: "Brand system, visual identity, design ops", category: "leadership", defaultName: "Aiko Tan", seatingZoneOverride: "product_design" },
  { key: "head_marketing", label: "Head of Marketing", description: "Marketing org, channel mix, positioning", category: "leadership", defaultName: "Jonas Weber", seatingZoneOverride: "marketing_growth" },
  { key: "head_growth", label: "Head of Growth", description: "Acquisition, retention, paid + organic experiments", category: "leadership", defaultName: "Riley Okafor", seatingZoneOverride: "marketing_growth" },
  { key: "head_research", label: "Head of Research", description: "Deep research, market intel, thesis dev", category: "leadership", defaultName: "Mira Chen", seatingZoneOverride: "data_research" },
  { key: "head_editorial", label: "Head of Editorial", description: "Content slate, voice, publishing cadence", category: "leadership", defaultName: "Theo Marsh", seatingZoneOverride: "editorial_content" },
  { key: "head_community", label: "Head of Community", description: "Community ops, advocate program, moderation", category: "leadership", defaultName: "Noor Aziz", seatingZoneOverride: "web3" },
  { key: "head_partnerships", label: "Head of Partnerships / BD", description: "Ecosystem deals, integrations, co-marketing", category: "leadership", defaultName: "Devon Park", seatingZoneOverride: "marketing_growth" },
  { key: "head_people", label: "Head of People", description: "Hiring, onboarding, culture rituals", category: "leadership", defaultName: "Adaeze Obi", seatingZoneOverride: "operations_admin" },

  // ── Engineering ────────────────────────────────────────────────────────
  { key: "senior_engineer", label: "Senior Engineer", description: "Generalist senior IC — ships features end-to-end", category: "engineering", defaultName: "Felix Romano" },
  { key: "frontend_engineer", label: "Frontend Engineer", description: "React/UI specialist, interaction polish", category: "engineering", defaultName: "Sora Tanigawa" },
  { key: "backend_engineer", label: "Backend Engineer", description: "APIs, data layer, services, reliability", category: "engineering", defaultName: "Ivan Petrov" },
  { key: "ml_engineer", label: "ML / AI Engineer", description: "Model integrations, prompt systems, RAG, evals", category: "engineering", defaultName: "Anika Roy" },
  { key: "devops_engineer", label: "DevOps / SRE", description: "Infra, CI/CD, observability, on-call", category: "engineering", defaultName: "Kenji Otsuka" },

  // ── Product / Design ───────────────────────────────────────────────────
  { key: "product_manager", label: "Product Manager", description: "Specs, prioritisation, customer interviews", category: "product_design", defaultName: "Hana Kowalski" },
  { key: "product_designer", label: "Product Designer", description: "End-to-end product flows, interaction + visual", category: "product_design", defaultName: "Lucia Ferraro" },
  { key: "brand_designer", label: "Brand Designer", description: "Identity systems, brand collateral, type", category: "product_design", defaultName: "Tomás Gallardo" },
  { key: "motion_designer", label: "Motion Designer", description: "Animations, video, interaction motion", category: "product_design", defaultName: "Ines Lemaire" },

  // ── Marketing / Growth ─────────────────────────────────────────────────
  { key: "growth_marketer", label: "Growth Marketer", description: "Acquisition experiments, conversion funnels", category: "marketing_growth", defaultName: "Maya Goldberg" },
  { key: "social_media_manager", label: "Social Media Manager", description: "Twitter/X, LinkedIn, channel narrative", category: "marketing_growth", defaultName: "Sami Ekstrand" },
  { key: "seo_specialist", label: "SEO Specialist", description: "Organic search, technical SEO, content briefs", category: "marketing_growth", defaultName: "Roshan Iyer" },
  { key: "pr_manager", label: "PR Manager", description: "Press relationships, briefings, media kit", category: "marketing_growth", defaultName: "Camille Dubois" },
  { key: "brand_manager", label: "Brand Manager", description: "Brand consistency, campaign management", category: "marketing_growth", defaultName: "Junko Sato" },

  // ── Editorial / Content ────────────────────────────────────────────────
  { key: "managing_editor", label: "Managing Editor", description: "Editorial calendar, copy review, fact checks", category: "editorial_content", defaultName: "Lior Stern" },
  { key: "senior_writer", label: "Senior Writer", description: "Long-form, opinion, deep dives", category: "editorial_content", defaultName: "Faye Eriksson" },
  { key: "copywriter", label: "Copywriter", description: "Short-form copy, landing pages, emails", category: "editorial_content", defaultName: "Owen Hatcher" },

  // ── Operations / Admin ────────────────────────────────────────────────
  { key: "chief_of_staff", label: "Chief of Staff", description: "Exec leverage, cross-team alignment, special projects", category: "operations_admin", defaultName: "Selene Park" },
  { key: "people_ops", label: "People Ops", description: "Onboarding, comp ops, HRIS, policy", category: "operations_admin", defaultName: "Mateo Alvarez" },
  { key: "finance_lead", label: "Finance Lead", description: "Bookkeeping, AP/AR, investor reporting", category: "operations_admin", defaultName: "Ravi Khurana" },
  { key: "legal_counsel", label: "Legal Counsel", description: "Contracts, compliance, IP, regulatory", category: "operations_admin", defaultName: "Astrid Halvorsen" },
  { key: "project_manager", label: "Project Manager", description: "Cross-functional delivery, timelines, risk", category: "operations_admin", defaultName: "Bilal Hossain" },

  // ── Sales / CS ────────────────────────────────────────────────────────
  { key: "account_executive", label: "Account Executive", description: "Closes deals, manages pipeline + named accounts", category: "sales_success", defaultName: "Helena Baros" },
  { key: "sdr", label: "Sales Development Rep", description: "Outbound prospecting, qualifying, booking demos", category: "sales_success", defaultName: "Quentin Clarke" },
  { key: "customer_success", label: "Customer Success Manager", description: "Onboarding, expansion, churn prevention", category: "sales_success", defaultName: "Pilar Cortes" },

  // ── Data / Research ───────────────────────────────────────────────────
  { key: "data_analyst", label: "Data Analyst", description: "Dashboards, deep-dives, growth analysis", category: "data_research", defaultName: "Toma Ishikawa" },
  { key: "ux_researcher", label: "UX Researcher", description: "Customer interviews, usability, jobs-to-be-done", category: "data_research", defaultName: "Greta Lindholm" },
  { key: "market_researcher", label: "Market Researcher", description: "Competitive intel, sizing, segmentation", category: "data_research", defaultName: "Idris Mansour" },

  // ── Web3 Specialty ────────────────────────────────────────────────────
  { key: "solidity_engineer", label: "Solidity Engineer", description: "EVM contracts, audits, gas optimisation", category: "web3", defaultName: "Vlad Cojocaru" },
  { key: "solana_engineer", label: "Solana Engineer", description: "Anchor programs, SPL tokens, on-chain ops", category: "web3", defaultName: "Diego Salinas" },
  { key: "onchain_analyst", label: "On-chain Analyst", description: "Wallet flows, protocol metrics, narrative trades", category: "web3", defaultName: "Sana Khalil" },
  { key: "tokenomics_designer", label: "Tokenomics Designer", description: "Token model, incentives, liquidity mechanics", category: "web3", defaultName: "Eitan Halevi" },
  { key: "smart_contract_auditor", label: "Smart Contract Auditor", description: "Security review, fuzzing, formal verification", category: "web3", defaultName: "Linnea Holm" },
  { key: "community_manager", label: "Community Manager", description: "Discord/Telegram daily ops, mods, events", category: "web3", defaultName: "Kofi Mensah" },
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
