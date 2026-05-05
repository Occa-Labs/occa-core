import { desc, eq, inArray, sql } from "drizzle-orm";
import { agents, agentRuntimeState, traces } from "@occa/shared/schema";
import type {
  AgentActivityState,
  AgentConnectionState,
  AgentDTO,
} from "@occa/shared/types";
import { db } from "../../../infra/database/client";

const ERROR_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 10 * 1000;

type AgentRow = typeof agents.$inferSelect;
type RuntimeRow = typeof agentRuntimeState.$inferSelect;

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

function toDTO(
  row: AgentRow,
  runtime: RuntimeRow | undefined,
  latestTrace: LatestTrace | undefined,
): AgentDTO {
  const { state: activityState, traceId: activityTraceId } = deriveActivity(
    latestTrace,
    DEFAULT_COOLDOWN_MS,
  );
  const connectionState = (runtime?.connectionState ??
    "unknown") as AgentConnectionState;
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    role: row.role,
    adapterType: row.adapterType,
    externalAgentId: row.externalAgentId,
    desiredSkills: row.desiredSkills,
    parentAgentId: row.parentAgentId,
    createdAt: row.createdAt.toISOString(),
    activityState,
    activityTraceId,
    connectionState,
    connectionCheckedAt: runtime?.connectionCheckedAt
      ? runtime.connectionCheckedAt.toISOString()
      : null,
    connectionError: runtime?.connectionError ?? null,
    provisioningState: row.provisioningState as AgentDTO["provisioningState"],
    provisioningError: row.provisioningError ?? null,
    workstationId: row.workstationId ?? null,
    modelOverride: row.modelOverride ?? null,
    agentPda: row.agentPda ?? null,
    agentAddress: row.agentAddress ?? null,
    agentIndex: row.agentIndex ?? null,
    custodyModel: row.custodyModel,
    derivationMsgVersion: row.derivationMsgVersion,
    agentChainTxSignature: row.agentChainTxSignature ?? null,
  };
}

export async function hydrateAgentDTOs(rows: AgentRow[]): Promise<AgentDTO[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [runtimeRows, latestTraceRows] = await Promise.all([
    db
      .select()
      .from(agentRuntimeState)
      .where(inArray(agentRuntimeState.agentId, ids)),
    db.execute<{
      agent_id: string;
      id: string;
      status: string;
      finished_at: Date | null;
    }>(sql`
      SELECT DISTINCT ON (agent_id) agent_id, id, status, finished_at
      FROM ${traces}
      WHERE ${inArray(traces.agentId, ids)}
      ORDER BY agent_id, created_at DESC
    `),
  ]);

  const runtimeByAgent = new Map<string, RuntimeRow>();
  for (const r of runtimeRows) runtimeByAgent.set(r.agentId, r);

  const latestByAgent = new Map<string, LatestTrace>();
  const latestTraceList =
    (
      latestTraceRows as unknown as {
        rows?: Array<{
          agent_id: string;
          id: string;
          status: string;
          finished_at: Date | string | null;
        }>;
      }
    ).rows ?? [];
  for (const r of latestTraceList) {
    latestByAgent.set(r.agent_id, {
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

  return rows.map((row) =>
    toDTO(row, runtimeByAgent.get(row.id), latestByAgent.get(row.id)),
  );
}

export async function hydrateAgentDTO(row: AgentRow): Promise<AgentDTO> {
  const [dto] = await hydrateAgentDTOs([row]);
  return dto;
}

// Exported in case callers need to filter/inspect latest-trace metadata too.
export async function loadLatestTrace(
  agentId: string,
): Promise<LatestTrace | null> {
  const [r] = await db
    .select({
      id: traces.id,
      status: traces.status,
      finishedAt: traces.finishedAt,
    })
    .from(traces)
    .where(eq(traces.agentId, agentId))
    .orderBy(desc(traces.createdAt))
    .limit(1);
  return r ? { id: r.id, status: r.status, finishedAt: r.finishedAt } : null;
}
