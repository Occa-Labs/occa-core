"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentRole, SkillDTO } from "@occa/shared/types";
import { ApiError, skillsApi } from "@/lib/api";

export interface UseSkillsResult {
  skills: SkillDTO[];
  loading: boolean;
  error: string | null;
  importSkill: (input: {
    source: string;
    allowedRoles: AgentRole[];
  }) => Promise<SkillDTO>;
  updateRoles: (id: string, allowedRoles: AgentRole[]) => Promise<SkillDTO>;
  remove: (id: string) => Promise<void>;
  refresh: (id: string) => Promise<{ updated: boolean; skill: SkillDTO }>;
  reload: () => Promise<void>;
}

// Shared query key. The `["skills"]` prefix lets any mutation invalidate
// every role variant at once: the Skill Library reads the unscoped list
// while an agent's Skills tab reads a role-scoped list, and an import in
// one must immediately refresh the other.
const skillsKey = (role?: string) => ["skills", role ?? null] as const;

export function useSkills(
  enabled: boolean = true,
  opts?: { role?: string },
): UseSkillsResult {
  const role = opts?.role;
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: skillsKey(role),
    queryFn: () => skillsApi.list(role ? { role } : undefined),
    enabled,
  });

  // Invalidate ALL skill variants, not just this hook's role scope, so a
  // mutation made in one window propagates to every other reader.
  const invalidateAll = useCallback(
    () => qc.invalidateQueries({ queryKey: ["skills"] }),
    [qc],
  );

  const importSkill = useCallback(
    async (input: { source: string; allowedRoles: AgentRole[] }) => {
      const res = await skillsApi.import(input);
      await invalidateAll();
      return res.skill;
    },
    [invalidateAll],
  );

  const updateRoles = useCallback(
    async (id: string, allowedRoles: AgentRole[]) => {
      const res = await skillsApi.patch(id, { allowedRoles });
      await invalidateAll();
      return res.skill;
    },
    [invalidateAll],
  );

  const remove = useCallback(
    async (id: string) => {
      await skillsApi.remove(id);
      await invalidateAll();
    },
    [invalidateAll],
  );

  const refresh = useCallback(
    async (id: string) => {
      const res = await skillsApi.refresh(id);
      await invalidateAll();
      return { updated: res.updated, skill: res.skill };
    },
    [invalidateAll],
  );

  const reload = useCallback(async () => {
    await invalidateAll();
  }, [invalidateAll]);

  return {
    skills: query.data?.skills ?? [],
    loading: query.isLoading,
    error: query.error
      ? query.error instanceof ApiError
        ? `api_${query.error.status}`
        : "network_error"
      : null,
    importSkill,
    updateRoles,
    remove,
    refresh,
    reload,
  };
}
