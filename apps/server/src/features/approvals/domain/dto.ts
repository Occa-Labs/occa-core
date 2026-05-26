import { approvals } from "@occa/shared/schema";
import type {
  ApprovalActionType,
  ApprovalDTO,
  ApprovalStatus,
} from "@occa/shared/types";
import { SYSTEM_PAYLOAD_KEYS } from "./schemas";

export function toApprovalDTO(row: typeof approvals.$inferSelect): ApprovalDTO {
  return {
    id: row.id,
    companyId: row.companyId,
    requestedByAgentId: row.requestedByDeploymentId,
    actionType: row.actionType as ApprovalActionType,
    payload: (row.payload as Record<string, unknown>) ?? {},
    status: row.status as ApprovalStatus,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByUserId: row.decidedByUserId ?? null,
    rejectionReason: row.rejectionReason ?? null,
  };
}

export function stripSystemKeys(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!SYSTEM_PAYLOAD_KEYS.has(k)) out[k] = v;
  }
  return out;
}
