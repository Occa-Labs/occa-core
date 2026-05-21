import { useCallback, useEffect, useState } from "react";
import { agentsApi } from "@/lib/api";
import type { WorkspaceFileDTO } from "@occa/shared/types";

interface UpdateFileResult {
  file: WorkspaceFileDTO;
  syncWarning?: { code: string; detail?: string };
}

interface AgentFilesState {
  files: WorkspaceFileDTO[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  updateFile: (filename: string, content: string) => Promise<UpdateFileResult>;
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

  const updateFile = useCallback(
    async (filename: string, content: string): Promise<UpdateFileResult> => {
      const res = await agentsApi.updateFile(agentId, filename, { content });
      setFiles((prev) =>
        prev.map((f) => (f.filename === filename ? res.file : f)),
      );
      return { file: res.file, syncWarning: res.syncWarning };
    },
    [agentId],
  );

  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [agentId, enabled, reload]);

  return { files, loading, error, reload, updateFile };
}
