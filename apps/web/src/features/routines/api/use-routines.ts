"use client";

// Hook for the routines CRUD surface. List of routines plus imperative
// create / patch / remove / run that update local state without a full
// re-fetch. Errors normalize to short codes ("api_404", etc.) so the UI
// can switch on them without re-parsing response bodies.

import { useCallback, useEffect, useState } from "react";
import type {
  CreateRoutineRequest,
  CreateTriggerRequest,
  RoutineDTO,
  UpdateRoutineRequest,
  UpdateTriggerRequest,
} from "@occa/shared/types";
import { ApiError, routinesApi } from "@/lib/api";

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

export interface UseRoutinesResult {
  routines: RoutineDTO[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  create: (input: CreateRoutineRequest) => Promise<RoutineDTO>;
  patch: (id: string, input: UpdateRoutineRequest) => Promise<RoutineDTO>;
  patchTrigger: (
    routineId: string,
    triggerId: string,
    input: UpdateTriggerRequest,
  ) => Promise<void>;
  createTrigger: (
    routineId: string,
    input: CreateTriggerRequest,
  ) => Promise<void>;
  remove: (id: string) => Promise<boolean>;
  run: (id: string) => Promise<boolean>;
}

export function useRoutines(enabled: boolean = true): UseRoutinesResult {
  const [routines, setRoutines] = useState<RoutineDTO[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const { routines } = await routinesApi.list();
      setRoutines(routines);
      setError(null);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setRoutines([]);
      setLoading(false);
      return;
    }
    void reload();
  }, [enabled, reload]);

  // create re-throws so the form can surface the error inline.
  const create = useCallback(async (input: CreateRoutineRequest) => {
    const { routine } = await routinesApi.create(input);
    setRoutines((prev) => [...prev, routine]);
    return routine;
  }, []);

  const patch = useCallback(
    async (id: string, input: UpdateRoutineRequest) => {
      const { routine } = await routinesApi.patch(id, input);
      setRoutines((prev) => prev.map((r) => (r.id === id ? routine : r)));
      return routine;
    },
    [],
  );

  // Trigger mutations re-throw so the edit form can surface the error.
  // Callers reload() afterward to refresh the routine's nested triggers.
  const patchTrigger = useCallback(
    async (
      routineId: string,
      triggerId: string,
      input: UpdateTriggerRequest,
    ) => {
      await routinesApi.patchTrigger(routineId, triggerId, input);
    },
    [],
  );

  const createTrigger = useCallback(
    async (routineId: string, input: CreateTriggerRequest) => {
      await routinesApi.createTrigger(routineId, input);
    },
    [],
  );

  const remove = useCallback(async (id: string) => {
    try {
      await routinesApi.remove(id);
      setRoutines((prev) => prev.filter((r) => r.id !== id));
      return true;
    } catch (err) {
      setError(extractError(err));
      return false;
    }
  }, []);

  const run = useCallback(async (id: string) => {
    try {
      await routinesApi.run(id);
      return true;
    } catch (err) {
      setError(extractError(err));
      return false;
    }
  }, []);

  return {
    routines,
    loading,
    error,
    reload,
    create,
    patch,
    patchTrigger,
    createTrigger,
    remove,
    run,
  };
}
