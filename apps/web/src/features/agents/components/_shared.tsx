"use client";

// Pure helpers + small visual primitives shared across the agent-window
// sub-components. Lives in `_shared` so the underscore signals "not a
// resource component" — readers know the file isn't another tab.

import type { SkillDTO } from "@occa/shared/types";

// Status visuals moved to a shared leaf so features/chats can reuse them
// without a cross-feature import. Re-exported here for back-compat with the
// many agents-window call sites that import them from `_shared`.
export {
  deriveStatusVisual,
  StatusDot,
  StatusPill,
  type StatusVisual,
} from "@/components/ui/agent-status";

export function roleAllows(skill: SkillDTO, role: string): boolean {
  return (
    skill.allowedRoles.length === 0 ||
    skill.allowedRoles.includes(role as SkillDTO["allowedRoles"][number])
  );
}

export function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatDuration(
  startedAt: string | null,
  finishedAt: string | null,
) {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

export function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)}h ago`;
  return `${Math.round(diffMs / 86_400_000)}d ago`;
}

// Re-export the canonical role catalog from @occa/shared. This was inline
// here historically; the inline copy drifted from the backend. The shared
// package is now the single source of truth — see role-catalog.ts.
export {
  ROLE_ORDER,
  ROLE_CATALOG,
  CSUITE_ROLES,
  roleLabelFor,
} from "@occa/shared/role-catalog";

import { ROLE_CATALOG } from "@occa/shared/role-catalog";

// Map of slug → display label, derived from ROLE_CATALOG. Local re-shape
// kept for the autocomplete component which expects a plain Record.
export const ROLE_LABELS: Record<string, string> = Object.fromEntries(
  ROLE_CATALOG.map((r) => [r.key, r.label]),
);
