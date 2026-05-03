import { useCallback, useEffect, useState } from "react";
import { agentsApi } from "@/lib/api";
import type { WorkspaceFileDTO } from "@occa/shared/types";

interface AgentFilesState {
  files: WorkspaceFileDTO[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useAgentFiles(
  agentId: string,
  enabled = true,
): AgentFilesState {
  const [files, setFiles] = useState<WorkspaceFileDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await agentsApi.files(agentId);
      setFiles(res.files);
    } catch {
      setError("Failed to load workspace files");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [agentId, enabled, reload]);

  return { files, loading, error, reload };
}
