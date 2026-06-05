"use client";

import { FileText } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { DocumentDTO } from "@/lib/api";
import { useInView } from "@/lib/use-in-view";
import { formatRelativeTime } from "../../utils/finder-format";

interface FinderGridViewProps {
  docs: DocumentDTO[];
  onOpen: (id: string) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

/** Icon-grid view: a file tile per document, name + relative time below. */
export function FinderGridView({
  docs,
  onOpen,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: FinderGridViewProps) {
  const sentinelRef = useInView(onLoadMore, hasNextPage);
  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] content-start gap-2">
        {docs.map((doc) => (
          <FinderGridTile key={doc.id} doc={doc} onOpen={() => onOpen(doc.id)} />
        ))}
      </div>

      {hasNextPage && <div ref={sentinelRef} className="h-px" />}
      {isFetchingNextPage && (
        <div className="flex items-center justify-center py-3">
          <Spinner variant="block" className="text-base text-white/40" />
        </div>
      )}
    </div>
  );
}

function FinderGridTile({
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
      className="flex cursor-pointer flex-col items-center gap-2 rounded-lg p-3 text-center transition hover:bg-white/5"
    >
      <span className="flex size-14 items-center justify-center rounded-lg border border-white/10 bg-white/5">
        <FileText className="size-7 text-white/45" />
      </span>
      <span className="line-clamp-2 text-xs text-white/85">{doc.title}</span>
      <span className="text-[10px] text-white/30">
        {formatRelativeTime(doc.createdAt)}
      </span>
    </button>
  );
}
