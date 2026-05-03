// Agent org-tree helpers used by the hire-with-approval flow.
//
// Hierarchy is encoded on `agents.parentAgentId` (self-FK). Top-level agents
// have `parentAgentId = null` (typically the CEO, reporting to the human).
// Hire authority follows the subtree:
//   * Top-level requester → may delegate to any agent in the same company.
//   * Non-top requester    → may only delegate to descendants of itself.
//   * Self-hire is always rejected.
//   * Cross-company is always rejected.

import { eq } from "drizzle-orm";
import { agents } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

const MAX_HIERARCHY_DEPTH = 32;

export type HireCheckReason =
  | "self_hire_forbidden"
  | "cross_company_forbidden"
  | "out_of_scope"
  | "requester_not_found"
  | "target_not_found";

export interface HireCheckResult {
  ok: boolean;
  reason?: HireCheckReason;
}

interface AgentNode {
  id: string;
  companyId: string;
  parentAgentId: string | null;
}

async function loadAgentNode(id: string): Promise<AgentNode | null> {
  const [row] = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      parentAgentId: agents.parentAgentId,
    })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);
  return row ?? null;
}

// Returns whether `requesterId` may delegate work to `targetId`. The check
// walks up the parent chain from the target; if it reaches `requesterId`,
// the target is a descendant. Top-level requesters (parentAgentId = null)
// short-circuit to "any agent in their company".
export async function canHire(
  requesterId: string,
  targetId: string,
): Promise<HireCheckResult> {
  if (requesterId === targetId) {
    return { ok: false, reason: "self_hire_forbidden" };
  }

  const requester = await loadAgentNode(requesterId);
  if (!requester) return { ok: false, reason: "requester_not_found" };

  const target = await loadAgentNode(targetId);
  if (!target) return { ok: false, reason: "target_not_found" };

  if (requester.companyId !== target.companyId) {
    return { ok: false, reason: "cross_company_forbidden" };
  }

  // Top-level requester (CEO / first agent / pre-org-chart) owns every
  // agent in the company until a hierarchy is wired up.
  if (requester.parentAgentId === null) return { ok: true };

  // Walk up from target. Stop on null parent or cycle (defensive — schema
  // doesn't enforce acyclicity).
  const visited = new Set<string>();
  let cursor: string | null = target.parentAgentId;
  let depth = 0;
  while (cursor && depth < MAX_HIERARCHY_DEPTH) {
    if (cursor === requesterId) return { ok: true };
    if (visited.has(cursor)) break;
    visited.add(cursor);
    const node = await loadAgentNode(cursor);
    if (!node) break;
    cursor = node.parentAgentId;
    depth += 1;
  }
  return { ok: false, reason: "out_of_scope" };
}

// Returns the set of agent IDs `rootId` can delegate to (its strict
// descendants in the same company). Used for org-chart rendering in the
// dispatcher prompt and any UI that wants to show "people you can hire".
// For top-level requesters this is everyone else in the company.
export async function listSubordinates(
  rootId: string,
): Promise<{ id: string; name: string; role: string }[]> {
  const root = await loadAgentNode(rootId);
  if (!root) return [];

  const sameCompany = await db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      parentAgentId: agents.parentAgentId,
    })
    .from(agents)
    .where(eq(agents.companyId, root.companyId));

  if (root.parentAgentId === null) {
    return sameCompany
      .filter((a) => a.id !== rootId)
      .map(({ id, name, role }) => ({ id, name, role }));
  }

  // BFS down the parent graph from rootId.
  const childrenByParent = new Map<string, string[]>();
  for (const a of sameCompany) {
    if (a.parentAgentId === null) continue;
    const arr = childrenByParent.get(a.parentAgentId) ?? [];
    arr.push(a.id);
    childrenByParent.set(a.parentAgentId, arr);
  }

  const descendants = new Set<string>();
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const kids = childrenByParent.get(id);
    if (!kids) continue;
    for (const kid of kids) {
      if (descendants.has(kid)) continue;
      descendants.add(kid);
      queue.push(kid);
    }
  }
  const indexed = new Map(sameCompany.map((a) => [a.id, a]));
  return Array.from(descendants)
    .map((id) => indexed.get(id))
    .filter(
      (a): a is NonNullable<typeof a> => a != null && a.id !== rootId,
    )
    .map(({ id, name, role }) => ({ id, name, role }));
}

// True iff `candidateParentId` is a descendant of `agentId`. Used to reject
// PATCH /agents/:id { parentAgentId } that would create a cycle.
export async function wouldCreateCycle(
  agentId: string,
  candidateParentId: string,
): Promise<boolean> {
  if (agentId === candidateParentId) return true;
  const visited = new Set<string>();
  let cursor: string | null = candidateParentId;
  let depth = 0;
  while (cursor && depth < MAX_HIERARCHY_DEPTH) {
    if (cursor === agentId) return true;
    if (visited.has(cursor)) return false;
    visited.add(cursor);
    const node = await loadAgentNode(cursor);
    if (!node) return false;
    cursor = node.parentAgentId;
    depth += 1;
  }
  return false;
}
