import { traceEvents, traces } from "@occa/shared/schema";
import type {
  LivenessState,
  SkillUsageEntry,
  TraceDTO,
  TraceEventDTO,
  TraceStatus,
  TraceUsage,
  WakeSource,
} from "@occa/shared/types";

export function toTraceDTO(row: typeof traces.$inferSelect): TraceDTO {
  return {
    id: row.id,
    agentId: row.deploymentId,
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
    skillsUsed: (row.skillsUsed as SkillUsageEntry[]) ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toEventDTO(row: typeof traceEvents.$inferSelect): TraceEventDTO {
  return {
    id: row.id,
    traceId: row.traceId,
    seq: row.seq,
    eventType: row.eventType,
    stream: row.stream ?? null,
    level: row.level ?? null,
    message: row.message ?? null,
    payload: (row.payload as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
