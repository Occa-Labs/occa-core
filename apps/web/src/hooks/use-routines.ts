"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  CreateRoutineRequest,
  RoutineDTO,
  UpdateRoutineRequest,
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
  create: (input: CreateRoutineRequest) => Promise<RoutineDTO | null>;
  update: (id: string, input: UpdateRoutineRequest) => Promise<RoutineDTO | null>;
  remove: (id: string) => Promise<boolean>;
}

export function useRoutines(enabled: boolean): UseRoutinesResult {
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

  const create = useCallback<UseRoutinesResult["create"]>(async (input) => {
    try {
      const { routine } = await routinesApi.create(input);
      setRoutines((prev) => [routine, ...prev]);
      return routine;
    } catch (err) {
      setError(extractError(err));
      return null;
    }
  }, []);

  const update = useCallback<UseRoutinesResult["update"]>(
    async (id, input) => {
      try {
        const { routine } = await routinesApi.patch(id, input);
        setRoutines((prev) => prev.map((r) => (r.id === id ? routine : r)));
        return routine;
      } catch (err) {
        setError(extractError(err));
        return null;
      }
    },
    [],
  );

  const remove = useCallback<UseRoutinesResult["remove"]>(async (id) => {
    try {
      await routinesApi.remove(id);
      setRoutines((prev) => prev.filter((r) => r.id !== id));
      return true;
    } catch (err) {
      setError(extractError(err));
      return false;
    }
  }, []);

  return { routines, loading, error, reload, create, update, remove };
}
