"use client";

// Minimal list of the company's workflows (yaml id + name) for the
// routine form's "Workflow" picker. Lives in the routines feature (not
// imported from features/workflows, which the boundary rules forbid) and
// reads through the shared `workflowsApi` in lib/api.

import { useCallback, useEffect, useState } from "react";
import { workflowsApi } from "@/lib/api";

export interface WorkflowOption {
  yamlId: string;
  name: string;
}

export interface UseWorkflowOptionsResult {
  workflows: WorkflowOption[];
  loading: boolean;
}

export function useWorkflowOptions(
  enabled: boolean = true,
): UseWorkflowOptionsResult {
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [loading, setLoading] = useState(enabled);

  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const { workflows } = await workflowsApi.list();
      setWorkflows(workflows.map((w) => ({ yamlId: w.yamlId, name: w.name })));
    } catch {
      setWorkflows([]);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setWorkflows([]);
      setLoading(false);
      return;
    }
    void reload();
  }, [enabled, reload]);

  return { workflows, loading };
}
