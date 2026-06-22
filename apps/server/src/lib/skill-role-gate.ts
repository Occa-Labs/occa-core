// Role gating for skills, shared by the catalog listing and the per-agent
// assign-validation so both compute eligibility the SAME way.
//
// A skill key can have several catalog rows for one company: a global / OCCA
// default seed plus a company-scoped import. The rule (decided with the
// product owner): "all roles" wins. If ANY row leaves allowedRoles empty, the
// skill is available to EVERY role in the company. Only when EVERY row carries
// a restriction does the gate apply, and then the eligible set is the union of
// those rows' roles.

import type { AgentRole } from "@occa/shared/types";

// Collapse the rows of a single key to one effective allowed-roles list.
// `[]` means all roles.
export function effectiveAllowedRoles(
  rowRoles: readonly (readonly AgentRole[])[],
): AgentRole[] {
  if (rowRoles.length === 0) return [];
  // An "all roles" row anywhere makes the whole skill all-roles.
  if (rowRoles.some((roles) => roles.length === 0)) return [];
  return [...new Set(rowRoles.flat())];
}

// Empty effective set = all roles.
export function isRoleAllowed(
  effectiveRoles: readonly AgentRole[],
  role: AgentRole,
): boolean {
  return effectiveRoles.length === 0 || effectiveRoles.includes(role);
}
