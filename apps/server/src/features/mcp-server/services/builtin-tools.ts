// Built-in OCCA tools that the MCP server exposes to external runtimes
// (Hermes Agent today). These wrap OCCA's existing repositories — no
// new persistence layer — so the tools stay thin proxies.
//
// Phase 1c starts with `list_tasks` because that's the single most
// useful read for an agent orchestrator (CEO checking what's on the
// team's plate before deciding what to delegate). More tools land here
// as the agent loop needs them: list_agents, read_document,
// get_agent_status, etc.
//
// Each tool is read-only for Phase 1c — write tools wait until auth is
// tightened (per-trace agent API key scoping in a later iteration).

import { z } from "zod";
import { listTasksByCompany } from "../../tasks/repositories/tasks";

/** Compact task summary safe to send to an LLM. Strip heavy fields
 *  (description, JSON blobs) so the context window doesn't get burned. */
export interface TaskSummary {
  id: string;
  number: number;
  title: string;
  status: string;
  assignedDeploymentId: string | null;
  parentTaskId: string | null;
  updatedAt: string;
}

export const listTasksInputSchema = {
  companyId: z
    .string()
    .uuid()
    .describe("UUID of the OCCA company whose tasks to list"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max number of tasks to return (default 20)"),
  includeArchived: z
    .boolean()
    .optional()
    .describe("Include archived tasks (default false)"),
};

export async function listTasksTool(input: {
  companyId: string;
  limit?: number;
  includeArchived?: boolean;
}): Promise<{ tasks: TaskSummary[]; total: number }> {
  const rows = await listTasksByCompany(input.companyId, {
    includeArchived: input.includeArchived ?? false,
  });
  const limit = input.limit ?? 20;
  const sliced = rows.slice(0, limit);
  return {
    tasks: sliced.map((t) => ({
      id: t.id,
      number: t.taskNumber,
      title: t.title,
      status: t.status,
      assignedDeploymentId: t.assignedDeploymentId,
      parentTaskId: t.parentTaskId,
      updatedAt: t.updatedAt instanceof Date ? t.updatedAt.toISOString() : String(t.updatedAt),
    })),
    total: rows.length,
  };
}
