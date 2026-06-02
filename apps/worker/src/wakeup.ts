import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  agentRuntimeProfile,
  companySkills,
  deployments,
  traces,
} from "@occa/shared/schema";
import type {
  SkillUsageEntry,
  WakeActor,
  WakeSource,
} from "@occa/shared/types";
import { db } from "./db";

// Snapshot duplicated from apps/server/src/services/trace-skill-snapshot.ts.
// Worker app has its own db client and can't import server services
// across apps; the query is short enough that duplication beats adding
// a new shared package.
async function snapshotDeploymentSkills(
  deploymentId: string,
  companyId: string,
): Promise<SkillUsageEntry[]> {
  try {
    const [profile] = await db
      .select({ desiredSkills: agentRuntimeProfile.desiredSkills })
      .from(agentRuntimeProfile)
      .where(eq(agentRuntimeProfile.deploymentId, deploymentId))
      .limit(1);
    if (!profile || profile.desiredSkills.length === 0) return [];

    const rows = await db
      .select({
        id: companySkills.id,
        key: companySkills.key,
        sourceRef: companySkills.sourceRef,
      })
      .from(companySkills)
      .where(
        and(
          or(
            eq(companySkills.companyId, companyId),
            isNull(companySkills.companyId),
          ),
          inArray(companySkills.key, profile.desiredSkills),
        ),
      );

    const byKey = new Map(rows.map((r) => [r.key, r]));
    return profile.desiredSkills
      .map((k) => byKey.get(k))
      .filter((r): r is (typeof rows)[number] => r != null);
  } catch {
    return [];
  }
}

export interface WakeupInput {
  agentId: string;
  source: WakeSource;
  triggerDetail?: string;
  reason?: string;
  taskId?: string | null;
  wakePayload?: Record<string, unknown>;
  idempotencyKey?: string;
  actor: WakeActor;
  scheduledAt?: Date;
  // Set when creating a retry/continuation trace so the attempt counter
  // and source trace are stamped directly rather than inferred from payload.
  failureRetryAttempt?: number;
  continuationAttempt?: number;
  retryOfTraceId?: string;
  retryReason?: string;
}

export interface WakeupResult {
  traceId: string;
  coalesced: boolean;
}

export async function wakeup(input: WakeupInput): Promise<WakeupResult> {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: deployments.id, companyId: deployments.companyId })
      .from(deployments)
      .where(eq(deployments.id, input.agentId))
      .limit(1);
    if (!agent) throw new Error("agent_not_found");

    // Idempotency: skip if a live trace with this key already exists.
    if (input.idempotencyKey) {
      const [dup] = await tx
        .select({ id: traces.id })
        .from(traces)
        .where(
          and(
            eq(traces.deploymentId, input.agentId),
            eq(traces.idempotencyKey, input.idempotencyKey),
            inArray(traces.status, ["queued", "running"]),
          ),
        )
        .limit(1);
      if (dup) return { traceId: dup.id, coalesced: true };
    }

    // Coalesce into an existing active trace ONLY when it covers the
    // same work unit — same taskId, or both task-less. A wake for a
    // different task must get its own trace; otherwise a second task
    // dispatched to a busy agent (e.g. two delegated stories to one
    // writer) would be silently swallowed.
    const sameWorkUnit = input.taskId
      ? eq(traces.taskId, input.taskId)
      : isNull(traces.taskId);
    const [activeTrace] = await tx
      .select({ id: traces.id })
      .from(traces)
      .where(
        and(
          eq(traces.deploymentId, input.agentId),
          inArray(traces.status, ["queued", "running"]),
          sameWorkUnit,
        ),
      )
      .orderBy(desc(traces.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });

    if (activeTrace) {
      await tx
        .update(traces)
        .set({
          coalescedCount: sql`${traces.coalescedCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(traces.id, activeTrace.id));
      return { traceId: activeTrace.id, coalesced: true };
    }

    // Create a new queued trace.
    const skillsUsed = await snapshotDeploymentSkills(
      input.agentId,
      agent.companyId!,
    );
    const [trace] = await tx
      .insert(traces)
      .values({
        companyId: agent.companyId!,
        deploymentId: input.agentId,
        invocationSource: input.source,
        triggerDetail: input.triggerDetail ?? null,
        taskId: input.taskId ?? null,
        wakePayload: input.wakePayload ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        actorType: input.actor.type,
        actorId: input.actor.id,
        status: "queued",
        scheduledAt: input.scheduledAt ?? null,
        failureRetryAttempt: input.failureRetryAttempt ?? 0,
        continuationAttempt: input.continuationAttempt ?? 0,
        retryOfTraceId: input.retryOfTraceId ?? null,
        retryReason: input.retryReason ?? null,
        skillsUsed,
      })
      .returning({ id: traces.id });

    return { traceId: trace.id, coalesced: false };
  });
}
