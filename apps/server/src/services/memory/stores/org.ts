// Org store — the agent's memory of its company structure: the active
// team, capability gaps in the default org chart, and the subset of
// agents that report to it. A memory TYPE; the assembler decides cadence
// (today: refreshed each call — the query is tiny and avoids staleness
// when the owner deploys mid-session).

import { and, eq } from "drizzle-orm";
import {
  ROLE_CATALOG,
  getTier,
  type RoleDefinition,
} from "@occa/shared/role-catalog";
import { agentIdentities, deployments } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { listSubordinates } from "../../../features/agents/services/deployment-hierarchy";
import { sortByDelegationPriority } from "../../delegation/policy";
import type { ContextOrg, ContextTeammate } from "../spec";

// Returns the full set of catalog roles in the default 35-persona org
// chart by walking the CEO entry's `manages` tree. Used to compute
// capability gaps. Excludes the CEO entry itself.
function defaultOrgChartRoles(): RoleDefinition[] {
  const ceoEntry = ROLE_CATALOG.find((r) => r.tier === "ceo");
  if (!ceoEntry) return [];
  const out: RoleDefinition[] = [];
  const seen = new Set<string>();
  const collect = (roleKey: string) => {
    if (seen.has(roleKey)) return;
    seen.add(roleKey);
    const def = ROLE_CATALOG.find((r) => r.key === roleKey);
    if (!def) return;
    out.push(def);
    for (const sub of def.manages) collect(sub);
  };
  for (const direct of ceoEntry.manages) collect(direct);
  return out;
}

// Loads the org chart for a deployment: active teammates (excluding self),
// undeployed catalog roles (gaps), and the agent's own subordinates sorted
// by delegation priority so renderers surface the best delegate first.
export async function loadOrg(args: {
  deploymentId: string;
  companyId: string;
}): Promise<ContextOrg> {
  const teamRows = await db
    .select({
      id: deployments.id,
      role: deployments.role,
      name: agentIdentities.name,
    })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(
      and(
        eq(deployments.companyId, args.companyId),
        eq(deployments.status, "active"),
      ),
    );

  const team: ContextTeammate[] = teamRows
    .filter((r) => r.id !== args.deploymentId)
    .map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      tier: (getTier(r.role) ?? "unknown") as ContextTeammate["tier"],
    }));

  const deployedRoles = new Set(teamRows.map((r) => r.role));
  const gaps = defaultOrgChartRoles()
    .filter((r) => !deployedRoles.has(r.key))
    .map((r) => ({
      role: r.key,
      tier: (getTier(r.key) ?? "unknown") as ContextTeammate["tier"],
    }));

  // Subordinates-for-self — what THIS agent can delegate to. CEO sees
  // everyone; a Head sees only their specialists; a specialist sees
  // nobody. Sorted via `sortByDelegationPriority` so the renderer's
  // "Available reports" block surfaces the highest-priority delegation
  // target first (head → direct_report → specialist).
  const subordinatesRaw = await listSubordinates(args.deploymentId);
  const subordinatesForSelf: ContextTeammate[] = sortByDelegationPriority(
    subordinatesRaw.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      tier: (getTier(r.role) ?? "unknown") as ContextTeammate["tier"],
    })),
  );

  return { team, gaps, subordinatesForSelf };
}
