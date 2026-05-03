"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  CreateTaskRequest,
  TaskDTO,
  UpdateTaskRequest,
} from "@occa/shared/types";
import { ApiError, tasksApi } from "@/lib/api";

export interface UseTasksResult {
  tasks: TaskDTO[];
  loading: boolean;
  error: string | null;
  create: (input: CreateTaskRequest) => Promise<TaskDTO | null>;
  update: (id: string, input: UpdateTaskRequest) => Promise<TaskDTO | null>;
  remove: (id: string) => Promise<boolean>;
  reload: () => Promise<void>;
}

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

const POLL_MS = 3_000;

export function useTasks(enabled: boolean): UseTasksResult {
  const [tasks, setTasks] = useState<TaskDTO[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const fetchTasks = useCallback(
    async (silent: boolean) => {
      if (!enabled) return;
      if (!silent) setLoading(true);
      try {
        const { tasks } = await tasksApi.list();
        setTasks(tasks);
        setError(null);
      } catch (err) {
        setError(extractError(err));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [enabled],
  );

  const reload = useCallback(() => fetchTasks(false), [fetchTasks]);

  useEffect(() => {
    if (!enabled) {
      setTasks([]);
      setLoading(false);
      return;
    }
    void fetchTasks(false);
    const t = setInterval(() => void fetchTasks(true), POLL_MS);
    return () => clearInterval(t);
  }, [enabled, fetchTasks]);

  const create = useCallback<UseTasksResult["create"]>(async (input) => {
    try {
      const { task } = await tasksApi.create(input);
      setTasks((prev) => [task, ...prev]);
      return task;
    } catch (err) {
      setError(extractError(err));
      return null;
    }
  }, []);

  const update = useCallback<UseTasksResult["update"]>(async (id, input) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id
          ? ({ ...t, ...input, tags: input.tags ?? t.tags } as TaskDTO)
          : t,
      ),
    );
    try {
      const { task } = await tasksApi.update(id, input);
      setTasks((prev) => prev.map((t) => (t.id === id ? task : t)));
      return task;
    } catch (err) {
      setError(extractError(err));
      await reload();
      return null;
    }
  }, [reload]);

  const remove = useCallback<UseTasksResult["remove"]>(async (id) => {
    const snapshot = tasks;
    setTasks((prev) => prev.filter((t) => t.id !== id));
    try {
      await tasksApi.remove(id);
      return true;
    } catch (err) {
      setError(extractError(err));
      setTasks(snapshot);
      return false;
    }
  }, [tasks]);

  return { tasks, loading, error, create, update, remove, reload };
}
