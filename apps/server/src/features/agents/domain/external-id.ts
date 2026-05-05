// External-id derivation for agents on the gateway side. Pure helpers —
// no DB, no network. Same logic used by routes/agents.ts,
// services/agent-create.ts, and services/kickoff-service.ts so they
// produce identical ids for the same OCCA agent.
//
// Format: `occa-<role>-<firstname>` (e.g. `occa-ceo-alice`,
// `occa-engineer-bob`). Human-readable id makes gateway-side ops
// (`openclaw agents list`, log lines, on-disk dirs under
// `~/.openclaw/agents/<id>`) self-explanatory. Falls back to a short
// hash slice from the OCCA UUID when role/name slugify to empty
// (exotic Unicode names, etc.).
//
// Collision risk: two hires with the same role + same first name in
// the same gateway will conflict. Provision RPC fails loudly with
// `agent_id_conflict` so the user sees it immediately and can rename.

const SLUG_MAX = 24;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
}

export function buildExternalAgentId(
  occaAgentId: string,
  role: string,
  name: string,
): string {
  const roleSlug = slugify(role);
  const firstNameSlug = slugify(name.split(/\s+/)[0] ?? "");
  // Fallback to a short hash slice so we always emit a valid
  // [a-z0-9-] id even when slugify yields empty strings.
  const fallback = occaAgentId.replace(/-/g, "").slice(0, 6);
  return `occa-${roleSlug || fallback}-${firstNameSlug || fallback}`;
}

export function buildWorkspacePath(externalAgentId: string): string {
  return `~/.openclaw/workspaces/${externalAgentId}`;
}
