// DTO mappers for agent-adjacent rows. Pure projections from Drizzle row
// shape → wire shape (`@occa/shared/types`). Lives in `domain/` because
// it has no Drizzle / Express / network dependencies — just type-level
// shaping the routes use to flatten DB rows into JSON responses.
//
// Mappers for the agent itself live in `services/agent-status.ts`
// (`hydrateAgentDTO` enriches with runtime state); this file covers the
// child resources that don't need that runtime hop.

import type {
  agentSkillSyncs,
  traces,
} from "@occa/shared/schema";
import type {
  AgentSkillSyncDTO,
  AgentSkillSyncStatus,
  LivenessState,
  TraceDTO,
  TraceStatus,
  TraceUsage,
  WakeSource,
} from "@occa/shared/types";

export function toSkillSyncDTO(
  row: typeof agentSkillSyncs.$inferSelect,
  derivedStatus?: AgentSkillSyncStatus,
): AgentSkillSyncDTO {
  return {
    id: row.id,
    agentId: row.agentId,
    skillKey: row.skillKey,
    status: (derivedStatus ?? row.status) as AgentSkillSyncStatus,
    action: row.action as AgentSkillSyncDTO["action"],
    skillRef: row.skillRef ?? null,
    skillUrl: row.skillUrl ?? null,
    lastError: row.lastError ?? null,
    installedAt: row.installedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toTraceDTO(row: typeof traces.$inferSelect): TraceDTO {
  return {
    id: row.id,
    agentId: row.agentId,
    companyId: row.companyId,
    taskId: row.taskId ?? null,
    conversationId: row.conversationId ?? null,
    retryOfTraceId: row.retryOfTraceId ?? null,
    invocationSource: row.invocationSource as WakeSource,
    triggerDetail: row.triggerDetail ?? null,
    status: row.status as TraceStatus,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    error: row.error ?? null,
    errorCode: row.errorCode ?? null,
    livenessState: (row.livenessState as LivenessState | null) ?? null,
    continuationAttempt: row.continuationAttempt,
    failureRetryAttempt: row.failureRetryAttempt ?? 0,
    retryReason: row.retryReason ?? null,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    usage: (row.usageJson as TraceUsage | null) ?? null,
    resultJson: (row.resultJson as Record<string, unknown> | null) ?? null,
    sessionIdAfter: row.sessionIdAfter ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
