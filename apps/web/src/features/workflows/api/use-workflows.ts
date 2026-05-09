"use client";

// Hook for the workflows CRUD surface. Mirrors `useRoutines` shape: a
// list of workflows, plus imperative create/patch/remove that update
// local state without re-fetching. Errors are normalized to short
// codes ("api_409", "workflow_id_conflict", etc.) so the UI can switch
// on them without re-parsing response bodies.

import { useCallback, useEffect, useState } from "react";
import type { WorkflowDTO } from "@occa/shared/types";
import { ApiError, workflowsApi } from "@/lib/api";

function extractError(err: unknown): string {
  if (err instanceof ApiError) {
    if (
      err.body &&
      typeof err.body === "object" &&
      "error" in err.body &&
      typeof (err.body as Record<string, unknown>).error === "string"
    ) {
      return (err.body as { error: string }).error;
    }
    return `api_${err.status}`;
  }
  return err instanceof Error ? err.message : "failed";
}

// The server returns more detail on workflow_yaml_invalid (the YAML
// parse error or Zod issue list); surface it raw so the editor can
// render it. ApiError already carries `body`, so callers can read
// (err as ApiError).body.detail directly when they need it.

export interface UseWorkflowsResult {
  workflows: WorkflowDTO[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  create: (input: {
    yamlText: string;
    enabled?: boolean;
  }) => Promise<WorkflowDTO | null>;
  patch: (
    id: string,
    input: { yamlText?: string; enabled?: boolean },
  ) => Promise<WorkflowDTO | null>;
  remove: (id: string) => Promise<boolean>;
}

export function useWorkflows(enabled: boolean = true): UseWorkflowsResult {
  const [workflows, setWorkflows] = useState<WorkflowDTO[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const { workflows } = await workflowsApi.list();
      setWorkflows(workflows);
      setError(null);
    } catch (err) {
      setError(extractError(err));
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

  const create = useCallback(
    async (input: { yamlText: string; enabled?: boolean }) => {
      try {
        const { workflow } = await workflowsApi.create(input);
        setWorkflows((prev) => [...prev, workflow]);
        return workflow;
      } catch (err) {
        // Re-throw so the editor can read err.body.detail; reload only
        // on transient errors.
        throw err;
      }
    },
    [],
  );

  const patch = useCallback(
    async (id: string, input: { yamlText?: string; enabled?: boolean }) => {
      try {
        const { workflow } = await workflowsApi.patch(id, input);
        setWorkflows((prev) =>
          prev.map((w) => (w.id === id ? workflow : w)),
        );
        return workflow;
      } catch (err) {
        throw err;
      }
    },
    [],
  );

  const remove = useCallback(async (id: string) => {
    try {
      await workflowsApi.remove(id);
      setWorkflows((prev) => prev.filter((w) => w.id !== id));
      return true;
    } catch (err) {
      setError(extractError(err));
      return false;
    }
  }, []);

  return { workflows, loading, error, reload, create, patch, remove };
}
