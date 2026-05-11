"use client";

import { useMemo, useState } from "react";
import { AppWindow } from "../../../components/ui/app-window";
import { EmptyState } from "../../../components/ui/empty-state";
import { Input } from "../../../components/ui/input";
import { LoadingState } from "../../../components/ui/loading-state";
import type { DocumentDTO } from "../../../lib/api";
import { useDocumentsList } from "../api/use-documents";
import { DocumentViewerModal } from "./document-viewer-modal";

interface DocumentsWindowProps {
  onClose: () => void;
}

export function DocumentsWindow({ onClose }: DocumentsWindowProps) {
  const [filter, setFilter] = useState("");
  // Server-side tag filter is comma-separated. UI strips into trimmed
  // tokens and resolves to undefined when blank so backend returns
  // recency-ordered.
  const tagList = useMemo(
    () =>
      filter
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    [filter],
  );
  const query = useDocumentsList({
    tags: tagList.length > 0 ? tagList : undefined,
    limit: 100,
  });
  const [activeId, setActiveId] = useState<string | null>(null);

  const documents = query.data ?? [];
  const activeDoc = useMemo(
    () =>
      activeId ? documents.find((d) => d.id === activeId) ?? null : null,
    [activeId, documents],
  );

  return (
    <AppWindow
      title="Documents"
      subtitle="Auto-saved task deliverables — agents can reference these later"
      onClose={onClose}
      defaultSize={{ w: 720, h: 560 }}
    >
      <div className="flex h-full flex-col gap-3 p-4">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by tag (comma-separated). Empty = all, by recency."
        />
        {query.isPending ? (
          <LoadingState />
        ) : documents.length === 0 ? (
          <EmptyState
            icon={<span className="text-2xl">📄</span>}
            title="No documents yet"
            description={
              tagList.length > 0
                ? "No documents match that tag filter."
                : "Documents accumulate as agents complete tasks."
            }
          />
        ) : (
          <ul className="flex flex-col gap-2 overflow-y-auto">
            {documents.map((doc) => (
              <DocumentListItem
                key={doc.id}
                doc={doc}
                onOpen={() => setActiveId(doc.id)}
              />
            ))}
          </ul>
        )}
      </div>

      {activeDoc && (
        <DocumentViewerModal
          doc={activeDoc}
          open
          onClose={() => setActiveId(null)}
        />
      )}
    </AppWindow>
  );
}

function DocumentListItem({
  doc,
  onOpen,
}: {
  doc: DocumentDTO;
  onOpen: () => void;
}) {
  const preview = doc.content.slice(0, 140).replace(/\n/g, " ");
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full cursor-pointer rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left transition hover:border-white/20 hover:bg-white/10"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="truncate text-sm font-medium text-white">
            {doc.title}
          </span>
          <span className="shrink-0 text-xs text-white/40">
            {formatRelativeTime(doc.createdAt)}
          </span>
        </div>
        <p className="mt-1 truncate text-xs text-white/50">
          {preview}
          {doc.content.length > 140 ? "…" : ""}
        </p>
        {doc.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {doc.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/60"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </button>
    </li>
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
