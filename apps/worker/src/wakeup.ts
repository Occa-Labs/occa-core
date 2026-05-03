import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { agents, traces } from "@occa/shared/schema";
import type { WakeActor, WakeSource } from "@occa/shared/types";
import { db } from "./db";

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
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1);
    if (!agent) throw new Error("agent_not_found");

    // Idempotency: skip if a live trace with this key already exists.
    if (input.idempotencyKey) {
      const [dup] = await tx
        .select({ id: traces.id })
        .from(traces)
        .where(
          and(
            eq(traces.agentId, input.agentId),
            eq(traces.idempotencyKey, input.idempotencyKey),
            inArray(traces.status, ["queued", "running"]),
          ),
        )
        .limit(1);
      if (dup) return { traceId: dup.id, coalesced: true };
    }

    // Coalesce into the existing active trace if one is running.
    const [activeTrace] = await tx
      .select({ id: traces.id })
      .from(traces)
      .where(
        and(
          eq(traces.agentId, input.agentId),
          inArray(traces.status, ["queued", "running"]),
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
    const [trace] = await tx
      .insert(traces)
      .values({
        companyId: agent.companyId,
        agentId: input.agentId,
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
      })
      .returning({ id: traces.id });

    return { traceId: trace.id, coalesced: false };
  });
}
