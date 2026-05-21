"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Copy,
  FileText,
  Loader2,
  Pencil,
} from "lucide-react";
import { useAgentFiles } from "@/features/agents/api/use-agent-files";

// Files the runtime writes to autonomously. Edits here are valid but the
// next agent wake may overwrite them.
const AGENT_WRITTEN_FILES = new Set(["HEARTBEAT.md", "MEMORY.md"]);

export function FilesTab({ agentId }: { agentId: string }) {
  const { files, loading, error, updateFile } = useAgentFiles(agentId, true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [syncWarning, setSyncWarning] = useState<{
    code: string;
    detail?: string;
  } | null>(null);

  const selected = files.find((f) => f.id === selectedId) ?? files[0] ?? null;
  const selectedFilename = selected?.filename ?? null;

  const dirty = useMemo(
    () => editing && selected !== null && draft !== selected.content,
    [editing, draft, selected],
  );

  // Reset transient state when switching agents.
  useEffect(() => {
    setSelectedId(null);
    setEditing(false);
    setDraft("");
    setSaveError(null);
    setSyncWarning(null);
  }, [agentId]);

  // Reset edit state when switching files.
  useEffect(() => {
    setEditing(false);
    setDraft("");
    setSaveError(null);
    setSyncWarning(null);
  }, [selectedFilename]);

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

  const handleEdit = useCallback(() => {
    if (!selected) return;
    setDraft(selected.content);
    setEditing(true);
    setSaveError(null);
    setSyncWarning(null);
  }, [selected]);

  const handleCancel = useCallback(() => {
    setEditing(false);
    setDraft("");
    setSaveError(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setSaveError(null);
    setSyncWarning(null);
    try {
      const res = await updateFile(selected.filename, draft);
      setEditing(false);
      setDraft("");
      if (res.syncWarning) setSyncWarning(res.syncWarning);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to save file",
      );
    } finally {
      setSaving(false);
    }
  }, [selected, draft, updateFile]);

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

  const isAgentWritten = selected
    ? AGENT_WRITTEN_FILES.has(selected.filename)
    : false;

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
              className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors relative cursor-pointer ${
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
              {(editing ? draft : selected.content).split("\n").length}L
            </span>
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={saving}
                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-white/40 hover:text-white/75 hover:bg-white/5 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || !dirty}
                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-white/80 bg-white/10 hover:bg-white/15 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? (
                    <>
                      <Loader2 className="size-3 animate-spin" /> Saving
                    </>
                  ) : (
                    <>
                      <Check className="size-3" /> Save
                    </>
                  )}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-white/40 hover:text-white/75 hover:bg-white/5 transition-colors cursor-pointer"
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
                <button
                  type="button"
                  onClick={handleEdit}
                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-white/40 hover:text-white/75 hover:bg-white/5 transition-colors cursor-pointer"
                >
                  <Pencil className="size-3" /> Edit
                </button>
              </>
            )}
          </div>

          {editing && isAgentWritten ? (
            <div className="shrink-0 flex items-start gap-2 px-4 py-2 border-b border-amber-300/15 bg-amber-300/5 text-[11px] text-amber-200/80">
              <AlertTriangle className="size-3.5 shrink-0 mt-px" />
              <span>
                The agent writes to {selected.filename} at runtime. Your edits
                may be overwritten on the next wake.
              </span>
            </div>
          ) : null}

          {syncWarning ? (
            <div className="shrink-0 flex items-start gap-2 px-4 py-2 border-b border-amber-300/15 bg-amber-300/5 text-[11px] text-amber-200/80">
              <AlertTriangle className="size-3.5 shrink-0 mt-px" />
              <span>
                Saved locally, but the gateway push failed ({syncWarning.code}
                {syncWarning.detail ? `: ${syncWarning.detail}` : ""}). The
                agent will still see the old file until sync succeeds.
              </span>
            </div>
          ) : null}

          {saveError ? (
            <div className="shrink-0 flex items-start gap-2 px-4 py-2 border-b border-red-300/15 bg-red-300/5 text-[11px] text-red-200/80">
              <AlertCircle className="size-3.5 shrink-0 mt-px" />
              <span>{saveError}</span>
            </div>
          ) : null}

          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            {editing ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="w-full h-full bg-transparent text-[12px] font-mono text-white/85 leading-relaxed outline-none resize-none whitespace-pre"
              />
            ) : (
              <pre className="text-[12px] font-mono text-white/75 whitespace-pre-wrap wrap-break-word leading-relaxed">
                {selected.content}
              </pre>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
