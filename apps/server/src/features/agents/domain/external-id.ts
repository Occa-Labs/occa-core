// External-id derivation for agents on the gateway side. Pure helpers —
// no DB, no network. Same logic used by routes/agents.ts and
// services/kickoff-service.ts so they produce identical ids for the
// same OCCA agent UUID.

// 8-char prefix slice keeps the gateway id short and deterministic.
// Collision risk on 8 hex chars is non-zero but acceptable per-company
// (gateway provision RPC fails loudly with `agent_id_conflict` if it
// ever does).
export function buildExternalAgentId(occaAgentId: string): string {
  return `occa-${occaAgentId.replace(/-/g, "").slice(0, 8)}`;
}

export function buildWorkspacePath(externalAgentId: string): string {
  return `~/.openclaw/workspaces/${externalAgentId}`;
}
