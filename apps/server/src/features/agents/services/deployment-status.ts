// Hydrate `DeploymentRow` → `AgentDTO` (the wire shape the web still
// consumes). The DTO field names are kept stable pending the domain
// step's migration of `@occa/shared/types` to `DeploymentDTO`. This
// service stitches together the four tables that replaced the old
// `agents` row:
//
//   deployments              — Truth tier (per-company role/index/parent)
//   agent_identities         — Truth tier (name/owner_wallet/PDA)
//   agent_runtime_profile    — Ephemeral (adapter, skills, seat, provisioning)
//   deployment_runtime_state — Ephemeral (connection state, last trace)

import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  agentIdentities,
  agentRuntimeProfile,
  deploymentRuntimeState,
  deployments,
  traces,
} from "@occa/shared/schema";
import type {
  AgentActivityState,
  AgentConnectionState,
  AgentDTO,
} from "@occa/shared/types";
import { db } from "../../../infra/database/client";

const ERROR_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 10 * 1000;

type DeploymentRow = typeof deployments.$inferSelect;
type IdentityRow = typeof agentIdentities.$inferSelect;
type RuntimeProfileRow = typeof agentRuntimeProfile.$inferSelect;
type RuntimeStateRow = typeof deploymentRuntimeState.$inferSelect;

interface LatestTrace {
  id: string;
  status: string;
  finishedAt: Date | null;
}

function deriveActivity(
  latestTrace: LatestTrace | undefined,
  cooldownMs: number,
): { state: AgentActivityState; traceId: string | null } {
  if (!latestTrace) return { state: "idle", traceId: null };
  const { status, finishedAt, id } = latestTrace;
  if (status === "queued" || status === "running") {
    return { state: "working", traceId: id };
  }
  const finishedMs = finishedAt ? finishedAt.getTime() : 0;
  const ageMs = finishedMs ? Date.now() - finishedMs : Infinity;
  if (status === "failed" || status === "timed_out") {
    if (ageMs <= ERROR_WINDOW_MS) return { state: "error", traceId: id };
  }
  if (status === "succeeded" && ageMs <= cooldownMs) {
    return { state: "cooldown", traceId: id };
  }
  return { state: "idle", traceId: null };
}

function toDTO(args: {
  deployment: DeploymentRow;
  identity: IdentityRow | undefined;
  profile: RuntimeProfileRow | undefined;
  runtimeState: RuntimeStateRow | undefined;
  latestTrace: LatestTrace | undefined;
  parentDeploymentIdByIndex: Map<number, string>;
}): AgentDTO {
  const { deployment, identity, profile, runtimeState, latestTrace } = args;
  const { state: activityState, traceId: activityTraceId } = deriveActivity(
    latestTrace,
    DEFAULT_COOLDOWN_MS,
  );
  const connectionState = (runtimeState?.connectionState ??
    "unknown") as AgentConnectionState;

  const parentAgentId =
    deployment.parentDeploymentIndex !== null
      ? args.parentDeploymentIdByIndex.get(deployment.parentDeploymentIndex) ??
        null
      : null;

  return {
    id: deployment.id,
    identityId: deployment.agentIdentityId,
    companyId: deployment.companyId,
    name: identity?.name ?? "",
    role: deployment.role,
    adapterType: profile?.adapterType ?? "",
    externalAgentId: profile?.externalAgentId ?? null,
    desiredSkills: profile?.desiredSkills ?? [],
    parentAgentId,
    createdAt: deployment.createdAt.toISOString(),
    activityState,
    activityTraceId,
    connectionState,
    connectionCheckedAt: runtimeState?.connectionCheckedAt
      ? runtimeState.connectionCheckedAt.toISOString()
      : null,
    connectionError: runtimeState?.connectionError ?? null,
    provisioningState:
      (profile?.provisioningState as AgentDTO["provisioningState"]) ?? "ready",
    provisioningError: profile?.provisioningError ?? null,
    workstationId: profile?.workstationId ?? null,
    modelOverride: profile?.modelOverride ?? null,
    agentPda: identity?.identityPda ?? null,
    agentIndex: deployment.deploymentIndex,
    ownerWallet: identity?.ownerWallet ?? null,
    operatingWallet: deployment.operatingWallet ?? null,
    agentChainTxSignature: deployment.chainTxSignature ?? null,
  };
}

export async function hydrateDeploymentDTOs(
  rows: DeploymentRow[],
): Promise<AgentDTO[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const identityIds = Array.from(new Set(rows.map((r) => r.agentIdentityId)));
  // For parent-index → deployment.id lookup we need every deployment in
  // each touched company (parents may be outside the input slice).
  const companyIds = Array.from(new Set(rows.map((r) => r.companyId)));

  const [
    identityRows,
    profileRows,
    runtimeStateRows,
    latestTraceRows,
    sameCompanyDeployments,
  ] = await Promise.all([
    db
      .select()
      .from(agentIdentities)
      .where(inArray(agentIdentities.id, identityIds)),
    db
      .select()
      .from(agentRuntimeProfile)
      .where(inArray(agentRuntimeProfile.deploymentId, ids)),
    db
      .select()
      .from(deploymentRuntimeState)
      .where(inArray(deploymentRuntimeState.deploymentId, ids)),
    db.execute<{
      deployment_id: string;
      id: string;
      status: string;
      finished_at: Date | null;
    }>(sql`
      SELECT DISTINCT ON (deployment_id) deployment_id, id, status, finished_at
      FROM ${traces}
      WHERE ${inArray(traces.deploymentId, ids)}
      ORDER BY deployment_id, created_at DESC
    `),
    db
      .select({
        id: deployments.id,
        companyId: deployments.companyId,
        deploymentIndex: deployments.deploymentIndex,
      })
      .from(deployments)
      .where(inArray(deployments.companyId, companyIds)),
  ]);

  const identityById = new Map(identityRows.map((r) => [r.id, r]));
  const profileByDeployment = new Map(
    profileRows.map((r) => [r.deploymentId, r]),
  );
  const runtimeStateByDeployment = new Map(
    runtimeStateRows.map((r) => [r.deploymentId, r]),
  );

  const latestByDeployment = new Map<string, LatestTrace>();
  const latestTraceList =
    (
      latestTraceRows as unknown as {
        rows?: Array<{
          deployment_id: string;
          id: string;
          status: string;
          finished_at: Date | string | null;
        }>;
      }
    ).rows ?? [];
  for (const r of latestTraceList) {
    latestByDeployment.set(r.deployment_id, {
      id: r.id,
      status: r.status,
      finishedAt:
        r.finished_at instanceof Date
          ? r.finished_at
          : r.finished_at
            ? new Date(r.finished_at)
            : null,
    });
  }

  // (companyId → (deploymentIndex → deploymentId)) for parent resolution.
  const parentLookupByCompany = new Map<string, Map<number, string>>();
  for (const d of sameCompanyDeployments) {
    let m = parentLookupByCompany.get(d.companyId);
    if (!m) {
      m = new Map();
      parentLookupByCompany.set(d.companyId, m);
    }
    m.set(d.deploymentIndex, d.id);
  }

  return rows.map((deployment) =>
    toDTO({
      deployment,
      identity: identityById.get(deployment.agentIdentityId),
      profile: profileByDeployment.get(deployment.id),
      runtimeState: runtimeStateByDeployment.get(deployment.id),
      latestTrace: latestByDeployment.get(deployment.id),
      parentDeploymentIdByIndex:
        parentLookupByCompany.get(deployment.companyId) ?? new Map(),
    }),
  );
}

export async function hydrateDeploymentDTO(
  row: DeploymentRow,
): Promise<AgentDTO> {
  const [dto] = await hydrateDeploymentDTOs([row]);
  return dto;
}

export async function loadLatestTrace(
  deploymentId: string,
): Promise<LatestTrace | null> {
  const [r] = await db
    .select({
      id: traces.id,
      status: traces.status,
      finishedAt: traces.finishedAt,
    })
    .from(traces)
    .where(eq(traces.deploymentId, deploymentId))
    .orderBy(desc(traces.createdAt))
    .limit(1);
  return r ? { id: r.id, status: r.status, finishedAt: r.finishedAt } : null;
}
