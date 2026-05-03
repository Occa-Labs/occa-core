"use client";

import { useCallback, useEffect, useState } from "react";
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
  reload: () => Promise<void>;
}

export function useSkills(
  enabled: boolean = true,
  opts?: { role?: string },
): UseSkillsResult {
  const role = opts?.role;
  const [skills, setSkills] = useState<SkillDTO[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const res = await skillsApi.list(role ? { role } : undefined);
      setSkills(res.skills);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? `api_${err.status}` : "network_error");
    } finally {
      setLoading(false);
    }
  }, [enabled, role]);

  useEffect(() => {
    if (!enabled) {
      setSkills([]);
      setLoading(false);
      return;
    }
    void reload();
  }, [enabled, reload]);

  const importSkill = useCallback(
    async (input: { source: string; allowedRoles: AgentRole[] }) => {
      const res = await skillsApi.import({
        source: input.source,
        allowedRoles: input.allowedRoles,
      });
      setSkills((prev) => {
        const without = prev.filter((s) => s.id !== res.skill.id);
        return [res.skill, ...without];
      });
      return res.skill;
    },
    [],
  );

  const updateRoles = useCallback(
    async (id: string, allowedRoles: AgentRole[]) => {
      const res = await skillsApi.patch(id, { allowedRoles });
      setSkills((prev) =>
        prev.map((s) => (s.id === id ? res.skill : s)),
      );
      return res.skill;
    },
    [],
  );

  const remove = useCallback(async (id: string) => {
    const prev = skills;
    setSkills((current) => current.filter((s) => s.id !== id));
    try {
      await skillsApi.remove(id);
    } catch (err) {
      setSkills(prev);
      throw err;
    }
  }, [skills]);

  return { skills, loading, error, importSkill, updateRoles, remove, reload };
}
