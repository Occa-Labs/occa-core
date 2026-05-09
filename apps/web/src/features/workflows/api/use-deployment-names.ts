"use client";

// Pulls the list of deployment names so the workflow form's assignee
// input can suggest real agents via <datalist>. Read-only; one-shot
// fetch on mount, no live invalidation. The form keeps the field as a
// free-text string so users can still type "human" or any custom value
// the YAML schema accepts.

import { useEffect, useState } from "react";
import { agentsApi } from "@/lib/api";

interface UseDeploymentNamesResult {
  names: string[];
  loading: boolean;
}

export function useDeploymentNames(): UseDeploymentNamesResult {
  const [names, setNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    agentsApi
      .list()
      .then((res) => {
        if (cancelled) return;
        const collected = res.agents
          .map((a) => a.name)
          .filter((n): n is string => typeof n === "string" && n.length > 0);
        setNames(Array.from(new Set(collected)).sort());
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
