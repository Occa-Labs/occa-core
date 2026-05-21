// Shared helpers for the tools feature routes — logger plus DTO mappers
// that turn catalog entries + DB rows into wire-shape responses.

import { childLogger } from "../../../lib/logger";
import type {
  AgentRole,
  CompanyToolDTO,
  ToolCallLogDTO,
  ToolCatalogEntry,
} from "@occa/shared/types";
import type { CompanyToolRow } from "../repositories/company-tools";
import type { ToolCallLogRow } from "../repositories/tool-call-logs";
import { findCatalogEntry } from "../services/catalog-loader";
import type { CatalogEntry } from "../domain/catalog-schemas";

export const log = childLogger("features:tools");

export async function toCompanyToolDTO(
  row: CompanyToolRow,
): Promise<CompanyToolDTO> {
  const catalog = await findCatalogEntry(row.type);
  const displayName = catalog?.displayName ?? row.type;
  return {
    id: row.id,
    companyId: row.companyId,
    type: row.type,
    displayName,
    label: row.label,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    status: row.status as CompanyToolDTO["status"],
    allowedRoles: (row.allowedRoles as AgentRole[]) ?? [],
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Synchronous list mapper for routes that have already pre-resolved the
// catalog dictionary.
export function toCompanyToolDTOSync(
  row: CompanyToolRow,
  catalogByType: Map<string, CatalogEntry>,
): CompanyToolDTO {
  const catalog = catalogByType.get(row.type);
  return {
    id: row.id,
    companyId: row.companyId,
    type: row.type,
    displayName: catalog?.displayName ?? row.type,
    label: row.label,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    status: row.status as CompanyToolDTO["status"],
    allowedRoles: (row.allowedRoles as AgentRole[]) ?? [],
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toCatalogWireEntry(entry: CatalogEntry): ToolCatalogEntry {
  return {
    type: entry.type,
    displayName: entry.displayName,
    description: entry.description,
    credentialFields: entry.credentialFields,
    metadataFields: entry.metadataFields,
    actions: entry.actions,
    hasTestConnection: entry.hasTestConnection,
    hasDynamicActions: entry.hasDynamicActions,
  };
}

export function toToolCallLogDTO(row: ToolCallLogRow): ToolCallLogDTO {
  return {
    id: row.id,
    toolId: row.toolId,
    deploymentId: row.deploymentId,
    action: row.action,
    status: row.status as ToolCallLogDTO["status"],
    resultSummary: (row.resultSummary as Record<string, unknown> | null) ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    latencyMs: row.latencyMs,
    createdAt: row.createdAt.toISOString(),
  };
}
