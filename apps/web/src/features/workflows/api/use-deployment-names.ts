"use client";

// Pulls the list of deployments (name + role) so the workflow form's
// assignee autocomplete can suggest real agents alongside their role
// label. Read-only; one-shot fetch on mount, no live invalidation. The
// form keeps the field as a free-text string so users can still type
// "human" or any custom value the YAML schema accepts.

import { useEffect, useState } from "react";
import { agentsApi } from "@/lib/api";

export interface DeploymentOption {
  name: string;
  role: string;
}

interface UseDeploymentNamesResult {
  names: DeploymentOption[];
  loading: boolean;
}

export function useDeploymentNames(): UseDeploymentNamesResult {
  const [names, setNames] = useState<DeploymentOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    agentsApi
      .list()
      .then((res) => {
        if (cancelled) return;
        const collected = res.agents
          .map((a) => ({
            name: typeof a.name === "string" ? a.name : "",
            role: typeof a.role === "string" ? a.role : "",
          }))
          .filter((d) => d.name.length > 0);
        const seen = new Set<string>();
        const deduped = collected.filter((d) => {
          if (seen.has(d.name)) return false;
          seen.add(d.name);
          return true;
        });
        deduped.sort((a, b) => a.name.localeCompare(b.name));
        setNames(deduped);
      })
      .catch(() => {
        // Best-effort: empty list keeps the input usable as free text.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { names, loading };
}
