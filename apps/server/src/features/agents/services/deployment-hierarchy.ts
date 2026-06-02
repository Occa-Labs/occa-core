// Deployment org-tree helpers used by the deploy-with-approval flow.
//
// Hierarchy is encoded on `deployments.parentDeploymentIndex` (per-company
// u32 mirror of the on-chain `Option<u32>`). Top-level deployments have
// NULL parent index (typically the CEO, reporting to the human). Deploy
// authority follows the subtree:
//   * Top-level requester → may delegate to any deployment in the same company.
//   * Non-top requester    → may only delegate to descendants of itself.
//   * Self-deploy is always rejected.
//   * Cross-company is always rejected.
//
// The parent edge is stored as `(companyId, parentDeploymentIndex)` rather
// than a UUID self-FK because the on-chain `Deployment` PDA references its
// parent by per-company index. We materialize a UUID parent on read by
// looking up `(companyId, deploymentIndex)` in the same company set.

import { eq } from "drizzle-orm";
import { agentIdentities, deployments } from "@occa/shared/schema";
import { getTier } from "@occa/shared/role-catalog";
import { db } from "../../../infra/database/client";

const MAX_HIERARCHY_DEPTH = 32;

// Only `tier === "ceo"` deployments are allowed the "top-level sees
// everyone" treatment. Other null-parent deployments are treated as
// having an empty subtree — a defensive guard against data anomalies
// where a non-CEO agent ends up without a parent index (which would
// otherwise let two top-level agents mutually delegate to each other
// in an unbounded loop, since each sees the other as a subordinate).
function isCeo(role: string): boolean {
  return getTier(role) === "ceo";
}

export type DeployCheckReason =
  | "self_deploy_forbidden"
  | "cross_company_forbidden"
  | "out_of_scope"
  | "requester_not_found"
  | "target_not_found";

export interface DeployCheckResult {
  ok: boolean;
  reason?: DeployCheckReason;
}

interface DeploymentNode {
  id: string;
  companyId: string;
  deploymentIndex: number;
  parentDeploymentIndex: number | null;
  name: string;
  role: string;
  // Lifecycle status mirrored from `deployments.status`. Tree walks
  // consider all nodes for hierarchy correctness (so paused interior
  // nodes don't break parent lookups), but delegation target listing
  // filters to `active` only — a paused agent can't be assigned work.
  status: "active" | "paused" | "retired";
}

// Pulls every deployment in the company JOINed with its identity name —
// a single round-trip covers both the parent-walk needs (index, parent
// index) and the listSubordinates output (name, role).
async function loadCompanyNodes(
  companyId: string,
): Promise<Map<string, DeploymentNode>> {
  const rows = await db
    .select({
      id: deployments.id,
      companyId: deployments.companyId,
      deploymentIndex: deployments.deploymentIndex,
      parentDeploymentIndex: deployments.parentDeploymentIndex,
      role: deployments.role,
      name: agentIdentities.name,
      status: deployments.status,
    })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(eq(deployments.companyId, companyId));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        ...r,
        companyId: r.companyId!,
        deploymentIndex: r.deploymentIndex!,
        status: r.status as DeploymentNode["status"],
      },
    ]),
  );
}

function indexOf(
  byId: Map<string, DeploymentNode>,
  deploymentIndex: number,
): DeploymentNode | undefined {
  for (const node of byId.values()) {
    if (node.deploymentIndex === deploymentIndex) return node;
  }
  return undefined;
}

async function loadDeploymentNode(id: string): Promise<DeploymentNode | null> {
  const [row] = await db
    .select({
      id: deployments.id,
      companyId: deployments.companyId,
      deploymentIndex: deployments.deploymentIndex,
      parentDeploymentIndex: deployments.parentDeploymentIndex,
      role: deployments.role,
      name: agentIdentities.name,
      status: deployments.status,
    })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(eq(deployments.id, id))
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    companyId: row.companyId!,
    deploymentIndex: row.deploymentIndex!,
    status: row.status as DeploymentNode["status"],
  };
}

// Returns whether `requesterId` may delegate work to `targetId`. Walks
// up the parent chain from the target via `parentDeploymentIndex`; if
// it reaches `requesterId`, the target is a descendant. Top-level
// requesters short-circuit to "any deployment in their company".
export async function canDeploy(
  requesterId: string,
  targetId: string,
): Promise<DeployCheckResult> {
  if (requesterId === targetId) {
    return { ok: false, reason: "self_deploy_forbidden" };
  }

  const requester = await loadDeploymentNode(requesterId);
  if (!requester) return { ok: false, reason: "requester_not_found" };

  const target = await loadDeploymentNode(targetId);
  if (!target) return { ok: false, reason: "target_not_found" };

  if (requester.companyId !== target.companyId) {
    return { ok: false, reason: "cross_company_forbidden" };
  }

  // Top-level + CEO tier short-circuit: CEO can delegate to anyone in
  // the company. Any other top-level deployment (data anomaly) falls
  // through to the descent walk below, which finds nothing — empty
  // subtree, out_of_scope.
  if (requester.parentDeploymentIndex === null && isCeo(requester.role)) {
    return { ok: true };
  }

  const byId = await loadCompanyNodes(requester.companyId);
  const visited = new Set<number>();
  let cursor: number | null = target.parentDeploymentIndex;
  let depth = 0;
  while (cursor !== null && depth < MAX_HIERARCHY_DEPTH) {
    const node = indexOf(byId, cursor);
    if (!node) break;
    if (node.id === requesterId) return { ok: true };
    if (visited.has(cursor)) break;
    visited.add(cursor);
    cursor = node.parentDeploymentIndex;
    depth += 1;
  }
  return { ok: false, reason: "out_of_scope" };
}

// Returns the set of deployment IDs `rootId` can delegate to (its
// strict descendants in the same company). Used for org-chart rendering
// in the dispatcher prompt and any UI that wants to show "people you
// can deploy". For top-level requesters this is everyone else in the
// company.
export async function listSubordinates(
  rootId: string,
): Promise<{ id: string; name: string; role: string }[]> {
  const root = await loadDeploymentNode(rootId);
  if (!root) return [];

  const byId = await loadCompanyNodes(root.companyId);

  // Specialists are leaf-only by design (hierarchical-agent-system
  // design doc §7: "Disable delegation at specialist layer — specialists
  // CANNOT delegate further. Prevents infinite loops.").
  if (getTier(root.role) === "specialist") {
    return [];
  }

  if (root.parentDeploymentIndex === null) {
    // Only CEO tier gets the "see everyone in company" treatment. Any
    // other null-parent deployment is treated as having an empty
    // subtree — see isCeo guard rationale.
    if (!isCeo(root.role)) return [];
    return Array.from(byId.values())
      .filter((n) => n.id !== rootId && n.status === "active")
      .map((n) => ({ id: n.id, name: n.name, role: n.role }));
  }

  // BFS down the parent graph keyed by deploymentIndex.
  const childrenByParentIndex = new Map<number, DeploymentNode[]>();
  for (const n of byId.values()) {
    if (n.parentDeploymentIndex === null) continue;
    const arr = childrenByParentIndex.get(n.parentDeploymentIndex) ?? [];
    arr.push(n);
    childrenByParentIndex.set(n.parentDeploymentIndex, arr);
  }

  const descendants = new Set<string>();
  const queue: number[] = [root.deploymentIndex];
  while (queue.length > 0) {
    const idx = queue.shift()!;
    const kids = childrenByParentIndex.get(idx);
    if (!kids) continue;
    for (const kid of kids) {
      if (descendants.has(kid.id)) continue;
      descendants.add(kid.id);
      queue.push(kid.deploymentIndex);
    }
  }
  return Array.from(descendants)
    .map((id) => byId.get(id))
    .filter(
      (n): n is DeploymentNode =>
        n != null && n.id !== rootId && n.status === "active",
    )
    .map((n) => ({ id: n.id, name: n.name, role: n.role }));
}

// True iff `candidateParentId` is a descendant of `deploymentId`. Used
// to reject PATCH /deployments/:id { parentDeploymentId } that would
// create a cycle.
export async function wouldCreateCycle(
  deploymentId: string,
  candidateParentId: string,
): Promise<boolean> {
  if (deploymentId === candidateParentId) return true;

  const subject = await loadDeploymentNode(deploymentId);
  if (!subject) return false;
  const candidate = await loadDeploymentNode(candidateParentId);
  if (!candidate) return false;
  if (candidate.companyId !== subject.companyId) return false;

  const byId = await loadCompanyNodes(subject.companyId);
  const visited = new Set<number>();
  let cursor: number | null = candidate.parentDeploymentIndex;
  let depth = 0;
  while (cursor !== null && depth < MAX_HIERARCHY_DEPTH) {
    if (cursor === subject.deploymentIndex) return true;
    if (visited.has(cursor)) return false;
    visited.add(cursor);
    const node = indexOf(byId, cursor);
    if (!node) return false;
    cursor = node.parentDeploymentIndex;
    depth += 1;
  }
  return false;
}
