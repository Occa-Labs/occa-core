// Catalog-driven reparenting post-hooks. Two trigger points:
//
//   • After a new head is deployed → scan active specialists in the
//     same company whose canonical parent (per role-catalog `manages`)
//     is the new head's role AND whose current parent is the CEO.
//     Reparent them under the new head.
//
//     Conservative on purpose: we only touch specialists currently
//     under CEO (the auto-resolve fallback). Any deliberate placement
//     under a different head stays as-is — we don't override user
//     intent.
//
//   • After a head is retired → scan its specialists and reparent
//     them back to the CEO. Without this, the retired head's subtree
//     becomes orphaned (parent_deployment_index pointing at a paused/
//     retired row) and listSubordinates returns empty for them via
//     the defensive null-parent guard.
//
// Returns the count + ids of moved deployments so route handlers can
// surface the change in the API response → UI toast.

import { and, eq } from "drizzle-orm";
import { deployments } from "@occa/shared/schema";
import type { AgentRole } from "@occa/shared/types";
import {
  CEO_ROLE,
  findCanonicalParentRole,
  getManagedRoles,
} from "@occa/shared/role-catalog";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";

const log = childLogger("deployment-reparent");

export interface ReparentResult {
  movedCount: number;
  movedDeploymentIds: string[];
  fromParentIndex: number | null;
  toParentIndex: number | null;
}

// Auto-resolve a parent for a non-CEO deployment with no explicit
// `parentDeploymentId`. Picks the active deployment that canonically
// manages this role per the catalog (e.g. senior_writer → head_marketing),
// or falls back to the company's CEO when no canonical head is deployed
// yet. Returns `null` only if neither candidate exists, which is an edge
// case the caller should still honor (e.g. very early provisioning when
// only the CEO is being deployed itself).
export async function resolveAutoParentIndex(args: {
  companyId: string;
  role: AgentRole;
}): Promise<number | null> {
  const canonicalParent = findCanonicalParentRole(args.role);
  if (canonicalParent) {
    const [match] = await db
      .select({ deploymentIndex: deployments.deploymentIndex })
      .from(deployments)
      .where(
        and(
          eq(deployments.companyId, args.companyId),
          eq(deployments.role, canonicalParent),
          eq(deployments.status, "active"),
        ),
      )
      .limit(1);
    if (match) return match.deploymentIndex;
  }
  const [ceo] = await db
    .select({ deploymentIndex: deployments.deploymentIndex })
    .from(deployments)
    .where(
      and(
        eq(deployments.companyId, args.companyId),
        eq(deployments.role, CEO_ROLE),
        eq(deployments.status, "active"),
      ),
    )
    .limit(1);
  return ceo?.deploymentIndex ?? null;
}

// Trigger after deploying a new head. Finds active specialists in the
// company whose canonical parent is the new head's role AND whose
// current parent is the CEO (auto-resolve fallback), and reparents
// them under the new head.
export async function reparentOnHeadDeploy(args: {
  companyId: string;
  newHeadDeploymentId: string;
  newHeadRole: AgentRole;
  newHeadDeploymentIndex: number;
}): Promise<ReparentResult> {
  const managed = getManagedRoles(args.newHeadRole);
  if (managed.length === 0) {
    return {
      movedCount: 0,
      movedDeploymentIds: [],
      fromParentIndex: null,
      toParentIndex: args.newHeadDeploymentIndex,
    };
  }

  // Identify the CEO's deployment_index so we know which "default
  // parent" rows are eligible for reparent. Any deployment whose
  // current parent != CEO is treated as deliberately placed and skipped.
  const [ceo] = await db
    .select({ deploymentIndex: deployments.deploymentIndex })
    .from(deployments)
    .where(
      and(
        eq(deployments.companyId, args.companyId),
        eq(deployments.role, CEO_ROLE),
        eq(deployments.status, "active"),
      ),
    )
    .limit(1);
  if (!ceo) {
    log.warn(
      { companyId: args.companyId, newHeadDeploymentId: args.newHeadDeploymentId },
      "reparentOnHeadDeploy skipped: no active CEO in company",
    );
    return {
      movedCount: 0,
      movedDeploymentIds: [],
      fromParentIndex: null,
      toParentIndex: args.newHeadDeploymentIndex,
    };
  }

  // Find candidate specialists: same company, role in managed list,
  // currently parented under CEO, active. Each candidate gets bumped
  // under the new head's deployment_index.
  const candidates = await db
    .select({
      id: deployments.id,
      role: deployments.role,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.companyId, args.companyId),
        eq(deployments.parentDeploymentIndex, ceo.deploymentIndex),
        eq(deployments.status, "active"),
      ),
    );
  const eligible = candidates.filter((c) =>
    (managed as readonly string[]).includes(c.role),
  );
  if (eligible.length === 0) {
    return {
      movedCount: 0,
      movedDeploymentIds: [],
      fromParentIndex: ceo.deploymentIndex,
      toParentIndex: args.newHeadDeploymentIndex,
    };
  }

  // Single UPDATE per row keeps the audit trail clean (each row gets
  // its own updated_at bump). For the small N expected here (a handful
  // of specialists) the loop cost is negligible.
  const movedIds: string[] = [];
  for (const c of eligible) {
    await db
      .update(deployments)
      .set({
        parentDeploymentIndex: args.newHeadDeploymentIndex,
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, c.id));
    movedIds.push(c.id);
  }
  log.info(
    {
      companyId: args.companyId,
      newHeadDeploymentId: args.newHeadDeploymentId,
      newHeadRole: args.newHeadRole,
      movedCount: movedIds.length,
    },
    "reparent on head deploy: specialists slid under new head",
  );
  return {
    movedCount: movedIds.length,
    movedDeploymentIds: movedIds,
    fromParentIndex: ceo.deploymentIndex,
    toParentIndex: args.newHeadDeploymentIndex,
  };
}

// Trigger before / after retiring a head. Reparent all active children
// of the retiring head back to the CEO so they don't end up pointing
// at a retired row. The defensive guard in listSubordinates would
// otherwise return empty for those rows.
//
// Idempotent: safe to call twice (second call finds no candidates).
export async function reparentOnHeadRetire(args: {
  companyId: string;
  retiringHeadDeploymentId: string;
  retiringHeadDeploymentIndex: number;
}): Promise<ReparentResult> {
  const [ceo] = await db
    .select({ deploymentIndex: deployments.deploymentIndex })
    .from(deployments)
    .where(
      and(
        eq(deployments.companyId, args.companyId),
        eq(deployments.role, CEO_ROLE),
        eq(deployments.status, "active"),
      ),
    )
    .limit(1);
  if (!ceo) {
    log.warn(
      {
        companyId: args.companyId,
        retiringHeadDeploymentId: args.retiringHeadDeploymentId,
      },
      "reparentOnHeadRetire skipped: no active CEO in company",
    );
    return {
      movedCount: 0,
      movedDeploymentIds: [],
      fromParentIndex: args.retiringHeadDeploymentIndex,
      toParentIndex: null,
    };
  }

  const children = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.companyId, args.companyId),
        eq(
          deployments.parentDeploymentIndex,
          args.retiringHeadDeploymentIndex,
        ),
      ),
    );
  if (children.length === 0) {
    return {
      movedCount: 0,
      movedDeploymentIds: [],
      fromParentIndex: args.retiringHeadDeploymentIndex,
      toParentIndex: ceo.deploymentIndex,
    };
  }

  const movedIds: string[] = [];
  for (const c of children) {
    await db
      .update(deployments)
      .set({
        parentDeploymentIndex: ceo.deploymentIndex,
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, c.id));
    movedIds.push(c.id);
  }
  log.info(
    {
      companyId: args.companyId,
      retiringHeadDeploymentId: args.retiringHeadDeploymentId,
      movedCount: movedIds.length,
    },
    "reparent on head retire: specialists returned to CEO",
  );
  return {
    movedCount: movedIds.length,
    movedDeploymentIds: movedIds,
    fromParentIndex: args.retiringHeadDeploymentIndex,
    toParentIndex: ceo.deploymentIndex,
  };
}
