"use client";

import { FileText } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { border } from "@/components/ui/tokens";
import type { DocumentDTO } from "@/lib/api";
import { useInView } from "@/lib/use-in-view";
import { formatShortDate } from "../../utils/finder-format";

interface FinderListViewProps {
  docs: DocumentDTO[];
  onOpen: (id: string) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

/** Column layout shared by the header and every row. */
const GRID_COLS = "grid grid-cols-[1fr_180px_120px] items-center gap-3";

/** macOS-style list view: a column header over single-line document rows. */
export function FinderListView({
  docs,
  onOpen,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: FinderListViewProps) {
  const sentinelRef = useInView(onLoadMore, hasNextPage);
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div
        className={`${GRID_COLS} sticky top-0 z-10 bg-[rgba(18,18,22,0.9)] px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-white/35 backdrop-blur`}
        style={{ borderBottom: border.divider }}
      >
        <span>Name</span>
        <span>Tags</span>
        <span>Modified</span>
      </div>

      {docs.map((doc) => (
        <FinderListRow key={doc.id} doc={doc} onOpen={() => onOpen(doc.id)} />
      ))}

      {hasNextPage && <div ref={sentinelRef} className="h-px" />}
      {isFetchingNextPage && (
        <div className="flex items-center justify-center py-3">
          <Spinner variant="block" className="text-base text-white/40" />
        </div>
      )}
    </div>
  );
}

function FinderListRow({
  doc,
  onOpen,
}: {
  doc: DocumentDTO;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`${GRID_COLS} cursor-pointer px-3 py-2 text-left transition hover:bg-white/5`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <FileText className="size-4 shrink-0 text-white/40" />
        <span className="truncate text-sm text-white/90">{doc.title}</span>
      </span>

      <span className="flex min-w-0 flex-wrap gap-1">
        {doc.tags.slice(0, 2).map((tag) => (
          <span
            key={tag}
            className="truncate rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/55"
          >
            {tag}
          </span>
        ))}
        {doc.tags.length > 2 && (
          <span className="text-[10px] text-white/30">
            +{doc.tags.length - 2}
          </span>
        )}
      </span>

      <span className="truncate text-xs text-white/40">
        {formatShortDate(doc.createdAt)}
      </span>
    </button>
  );
}
