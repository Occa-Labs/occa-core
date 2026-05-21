// Local route helpers — the user-company lookup and Row → DTO mappers.
// Not exported beyond this folder.

import { and, eq, isNull } from "drizzle-orm";
import { companies } from "@occa/shared/schema";
import type {
  RoutineDTO,
  RoutineTriggerDTO,
  RoutineTriggerKind,
} from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import type {
  RoutineRow,
  RoutineTriggerRow,
} from "../repositories/routines";

// Returns the user's primary user-company (kind='user', not soft-
// deleted). Mirrors the same helper in features/tasks and features/skills
// — kept local because it's an ownership check specific to the user-JWT
// route surface.
export async function userCompanyId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(
        eq(companies.ownerUserId, userId),
        eq(companies.kind, "user"),
        isNull(companies.deletedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

export function toTriggerDTO(row: RoutineTriggerRow): RoutineTriggerDTO {
  return {
    id: row.id,
    routineId: row.routineId,
    kind: row.kind as RoutineTriggerKind,
    label: row.label ?? null,
    enabled: row.enabled,
    cronExpression: row.cronExpression ?? null,
    timezone: row.timezone ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
  };
}

export function toRoutineDTO(
  row: RoutineRow,
  triggers: RoutineTriggerDTO[],
): RoutineDTO {
  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title,
    description: row.description ?? null,
    assigneeAgentId: row.assigneeDeploymentId ?? null,
    priority: row.priority,
    status: row.status,
    concurrencyPolicy: row.concurrencyPolicy,
    catchUpPolicy: row.catchUpPolicy,
    variables: (row.variables as Record<string, unknown> | null) ?? null,
    lastTriggeredAt: row.lastTriggeredAt?.toISOString() ?? null,
    lastEnqueuedAt: row.lastEnqueuedAt?.toISOString() ?? null,
    triggers,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
