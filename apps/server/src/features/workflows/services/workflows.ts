// Workflow CRUD orchestration. Parses YAML through the shared validator,
// derives the canonical fields the table needs (`yaml_id`, `name`,
// `description`) from the validated definition, and writes
// `yaml_text` + `parsed_definition` atomically — they are guaranteed
// to agree because both come from the same parse result.
//
// Phase 5 is storage only. The Phase 6 engine reads `parsed_definition`
// at trigger time without re-parsing.

import { parseWorkflowYaml } from "@occa/shared/workflows";
import type {
  WorkflowDefinition,
  WorkflowParseFailure,
} from "@occa/shared/workflows";
import type { WorkflowDTO } from "@occa/shared/types";
import { childLogger } from "../../../lib/logger";
import {
  deleteWorkflow as deleteWorkflowRow,
  findWorkflowByYamlId,
  findWorkflowInCompany,
  insertWorkflow,
  listWorkflowsForCompany,
  updateWorkflow as updateWorkflowRow,
  type WorkflowRow,
} from "../repositories/workflows";

const log = childLogger("services:workflows");

export type WorkflowServiceFailure =
  | { kind: "yaml_invalid"; error: WorkflowParseFailure }
  | { kind: "id_conflict"; yamlId: string }
  | { kind: "not_found" };

export type WorkflowServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: WorkflowServiceFailure };

function deriveStorageFields(definition: WorkflowDefinition): {
  yamlId: string;
  name: string;
  description: string | null;
} {
  return {
    yamlId: definition.id,
    name: definition.name,
    description: definition.description ?? null,
  };
}

function rowToDTO(row: WorkflowRow): WorkflowDTO {
  return {
    id: row.id,
    companyId: row.companyId,
    yamlId: row.yamlId,
    name: row.name,
    description: row.description ?? null,
    yamlText: row.yamlText,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listWorkflows(
  companyId: string,
): Promise<WorkflowDTO[]> {
  const rows = await listWorkflowsForCompany(companyId);
  return rows.map(rowToDTO);
}

export async function getWorkflow(
  workflowId: string,
  companyId: string,
): Promise<WorkflowServiceResult<WorkflowDTO>> {
  const row = await findWorkflowInCompany(workflowId, companyId);
  if (!row) return { ok: false, failure: { kind: "not_found" } };
  return { ok: true, value: rowToDTO(row) };
}

export async function createWorkflow(
  companyId: string,
  input: { yamlText: string; enabled?: boolean },
): Promise<WorkflowServiceResult<WorkflowDTO>> {
  const parsed = parseWorkflowYaml(input.yamlText);
  if (!parsed.ok) {
    return { ok: false, failure: { kind: "yaml_invalid", error: parsed.error } };
  }

  const fields = deriveStorageFields(parsed.value.definition);

  const existing = await findWorkflowByYamlId(fields.yamlId, companyId);
  if (existing) {
    return {
      ok: false,
      failure: { kind: "id_conflict", yamlId: fields.yamlId },
    };
  }

  const row = await insertWorkflow({
    companyId,
    yamlId: fields.yamlId,
    name: fields.name,
    description: fields.description,
    yamlText: parsed.value.yamlText,
    parsedDefinition: parsed.value.definition,
    enabled: input.enabled ?? true,
  });
  log.info(
    { workflowId: row.id, yamlId: fields.yamlId, companyId },
    "workflow created",
  );
  return { ok: true, value: rowToDTO(row) };
}

export async function updateWorkflow(
  workflowId: string,
  companyId: string,
  patch: { yamlText?: string; enabled?: boolean },
): Promise<WorkflowServiceResult<WorkflowDTO>> {
  const existing = await findWorkflowInCompany(workflowId, companyId);
  if (!existing) return { ok: false, failure: { kind: "not_found" } };

  const updates: Parameters<typeof updateWorkflowRow>[2] = {};

  if (patch.yamlText !== undefined && patch.yamlText !== existing.yamlText) {
    const parsed = parseWorkflowYaml(patch.yamlText);
    if (!parsed.ok) {
      return {
        ok: false,
        failure: { kind: "yaml_invalid", error: parsed.error },
      };
    }
    const fields = deriveStorageFields(parsed.value.definition);

    // yaml_id rename collides with another workflow in this company.
    if (fields.yamlId !== existing.yamlId) {
      const conflict = await findWorkflowByYamlId(fields.yamlId, companyId);
      if (conflict && conflict.id !== existing.id) {
        return {
          ok: false,
          failure: { kind: "id_conflict", yamlId: fields.yamlId },
        };
      }
    }

    updates.yamlText = parsed.value.yamlText;
    updates.parsedDefinition = parsed.value.definition;
    updates.yamlId = fields.yamlId;
    updates.name = fields.name;
    updates.description = fields.description;
  }

  if (patch.enabled !== undefined) {
    updates.enabled = patch.enabled;
  }

  if (Object.keys(updates).length === 0) {
    return { ok: true, value: rowToDTO(existing) };
  }

  const row = await updateWorkflowRow(workflowId, companyId, updates);
  if (!row) return { ok: false, failure: { kind: "not_found" } };
  log.info({ workflowId, companyId }, "workflow updated");
  return { ok: true, value: rowToDTO(row) };
}

export async function deleteWorkflow(
  workflowId: string,
  companyId: string,
): Promise<WorkflowServiceResult<{ id: string }>> {
  const existed = await deleteWorkflowRow(workflowId, companyId);
  if (!existed) return { ok: false, failure: { kind: "not_found" } };
  log.info({ workflowId, companyId }, "workflow deleted");
  return { ok: true, value: { id: workflowId } };
}
