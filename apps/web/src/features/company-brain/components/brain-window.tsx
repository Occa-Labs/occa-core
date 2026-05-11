"use client";

import { useMemo, useState } from "react";
import { AppWindow } from "../../../components/ui/app-window";
import { Button } from "../../../components/ui/button";
import { EmptyState } from "../../../components/ui/empty-state";
import { LoadingState } from "../../../components/ui/loading-state";
import type { BrainFileDTO } from "../../../lib/api";
import { useBrainFiles } from "../api/use-brain-files";
import { BrainEditorModal } from "./brain-editor-modal";
import { BrainCreateModal } from "./brain-create-modal";

interface BrainWindowProps {
  onClose: () => void;
}

export function BrainWindow({ onClose }: BrainWindowProps) {
  const filesQuery = useBrainFiles();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const files = filesQuery.data ?? [];
  const activeFile = useMemo(
    () => (activeId ? files.find((f) => f.id === activeId) ?? null : null),
    [activeId, files],
  );

  return (
    <AppWindow
      title="Company Brain"
      subtitle="Persistent knowledge agents read every turn"
      onClose={onClose}
      defaultSize={{ w: 720, h: 560 }}
      headerRight={
        <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
          New file
        </Button>
      }
    >
      <div className="flex h-full flex-col gap-3 p-4">
        {filesQuery.isPending ? (
          <LoadingState />
        ) : files.length === 0 ? (
          <EmptyState
            icon={<span className="text-2xl">🧠</span>}
            title="No brain files yet"
            description="Add glossary, ICP, or do/don't notes so agents stay on-brand."
            action={
              <Button onClick={() => setCreateOpen(true)}>Create first file</Button>
            }
          />
        ) : (
          <ul className="flex flex-col gap-2 overflow-y-auto">
            {files.map((file) => (
              <BrainListItem
                key={file.id}
                file={file}
                onOpen={() => setActiveId(file.id)}
              />
            ))}
          </ul>
        )}
      </div>

      {activeFile && (
        <BrainEditorModal
          file={activeFile}
          open
          onClose={() => setActiveId(null)}
        />
      )}
      {createOpen && (
        <BrainCreateModal open onClose={() => setCreateOpen(false)} />
      )}
    </AppWindow>
  );
}

function BrainListItem({
  file,
  onOpen,
}: {
  file: BrainFileDTO;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full cursor-pointer rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left transition hover:border-white/20 hover:bg-white/10"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-sm text-white">{file.path}</span>
          <VisibilityBadge value={file.visibility} />
        </div>
        <div className="mt-1 text-xs text-white/50">
          {file.sizeBytes} bytes · updated {formatRelativeTime(file.updatedAt)}
        </div>
      </button>
    </li>
  );
}

function VisibilityBadge({ value }: { value: BrainFileDTO["visibility"] }) {
  const map: Record<BrainFileDTO["visibility"], { label: string; tone: string }> = {
    all: { label: "all", tone: "bg-emerald-500/15 text-emerald-300" },
    "tier:head": { label: "heads", tone: "bg-sky-500/15 text-sky-300" },
    ceo_only: { label: "ceo only", tone: "bg-amber-500/15 text-amber-300" },
  };
  const cfg = map[value];
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cfg.tone}`}
    >
      {cfg.label}
    </span>
  );
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
