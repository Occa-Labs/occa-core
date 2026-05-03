"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, Copy, FileText, Loader2 } from "lucide-react";
import { useAgentFiles } from "@/features/agents/api/use-agent-files";

export function FilesTab({ agentId }: { agentId: string }) {
  const { files, loading, error } = useAgentFiles(agentId, true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const selected = files.find((f) => f.id === selectedId) ?? files[0] ?? null;

  useEffect(() => {
    setSelectedId(null);
  }, [agentId]);

  const handleCopy = useCallback(async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  }, [selected]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-white/40">
        <Loader2 className="size-3.5 animate-spin mr-2" /> Loading files…
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-red-300/80">
        <AlertCircle className="size-3.5 mr-2" /> {error}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-white/50">No workspace files seeded yet</p>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* File list sidebar */}
      <div className="w-44 shrink-0 flex flex-col border-r border-white/8 py-2 overflow-y-auto">
        {files.map((f) => {
          const active = f.id === (selected?.id ?? null);
          return (
            <button
              key={f.id}
              onClick={() => setSelectedId(f.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors relative ${
                active ? "bg-white/8" : "hover:bg-white/4"
              }`}
            >
              {active && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full bg-white/70" />
              )}
              <FileText
                className={`size-3.5 shrink-0 ${active ? "text-white/60" : "text-white/25"}`}
              />
              <span
                className={`text-[11px] font-mono truncate ${active ? "text-white/90" : "text-white/55"}`}
              >
                {f.filename}
              </span>
            </button>
          );
        })}
      </div>

      {/* File content pane */}
      {selected ? (
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-white/8">
            <span className="text-[11px] font-mono text-white/60 flex-1 truncate">
              {selected.filename}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-white/30 px-1.5 py-0.5 rounded bg-white/5">
              {selected.source}
            </span>
            <span className="text-[10px] text-white/25">
              {selected.content.split("\n").length}L
            </span>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-white/40 hover:text-white/75 hover:bg-white/5 transition-colors"
            >
              {copied ? (
                <>
                  <Check className="size-3" /> Copied
                </>
              ) : (
                <>
                  <Copy className="size-3" /> Copy
                </>
              )}
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            <pre className="text-[12px] font-mono text-white/75 whitespace-pre-wrap wrap-break-word leading-relaxed">
              {selected.content}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
