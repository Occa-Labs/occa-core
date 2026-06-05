"use client";

import { useEffect, useMemo, useState } from "react";
import { AppWindow } from "@/components/ui/app-window";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingState } from "@/components/ui/loading-state";
import { usePersistentState } from "@/lib/persistent-state";
import { useDocumentFolders } from "../../api/use-document-folders";
import { useDocumentPage } from "../../api/use-document-page";
import type { FinderFolder, FinderViewMode, GroupAxis } from "../../types";
import { ALL_FOLDER_ID, UNTAGGED_FOLDER_ID } from "../../types";
import { dayLabel } from "../../utils/date-buckets";
import { DocumentViewerModal } from "../document-viewer-modal";
import { FinderFolderGrid } from "./finder-folder-grid";
import { FinderGridView } from "./finder-grid-view";
import { FinderListView } from "./finder-list-view";
import { FinderSidebar } from "./finder-sidebar";
import { FinderToolbar } from "./finder-toolbar";

interface FinderWindowProps {
  onClose: () => void;
}

/**
 * macOS Finder-style window over the auto-saved documents. Folders + counts
 * come from a server aggregate (no document bodies); opening a folder or
 * searching pulls one paginated page at a time. The full archive is never
 * loaded at once.
 */
export function FinderWindow({ onClose }: FinderWindowProps) {
  const [selectedFolder, setSelectedFolder] = useState<string>(ALL_FOLDER_ID);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = usePersistentState<FinderViewMode>(
    "occa_finder_view",
    "list",
  );
  const [groupAxis, setGroupAxis] = usePersistentState<GroupAxis>(
    "occa_finder_group",
    "tags",
  );
  const [activeId, setActiveId] = useState<string | null>(null);

  // Debounce the search so each keystroke doesn't fire a server query — the
  // input stays responsive while the request only fires after a short pause.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const searching = debouncedSearch.trim().length > 0;
  const foldersQuery = useDocumentFolders(groupAxis, true);

  // Folder grid is the root view; documents only fetch once a folder is
  // opened or a search is active.
  const docsEnabled = selectedFolder !== ALL_FOLDER_ID || searching;
  const pageQuery = useDocumentPage(
    { folderId: selectedFolder, axis: groupAxis, search: debouncedSearch },
    docsEnabled,
  );

  const folders: FinderFolder[] = useMemo(() => {
    const raw = foldersQuery.data?.folders ?? [];
    // Date folders arrive as YYYY-MM-DD ids; label them Today/Yesterday/abs.
    return groupAxis === "date"
      ? raw.map((f) => ({ id: f.id, label: dayLabel(f.id), count: f.count }))
      : raw;
  }, [foldersQuery.data, groupAxis]);

  const untaggedCount =
    groupAxis === "tags" ? foldersQuery.data?.untagged ?? 0 : 0;
  const total = foldersQuery.data?.total ?? 0;

  const docs = useMemo(
    () => pageQuery.data?.pages.flatMap((p) => p.documents) ?? [],
    [pageQuery.data],
  );
  const activeDoc = useMemo(
    () => (activeId ? docs.find((d) => d.id === activeId) ?? null : null),
    [activeId, docs],
  );

  const showFolderGrid =
    !searching &&
    selectedFolder === ALL_FOLDER_ID &&
    (folders.length > 0 || untaggedCount > 0);

  const folderLabel = searching
    ? `Search: ${search.trim()}`
    : labelForFolder(selectedFolder, folders);
  const headerCount = searching
    ? docs.length
    : selectedFolder === ALL_FOLDER_ID
      ? total
      : folders.find((f) => f.id === selectedFolder)?.count ??
        (selectedFolder === UNTAGGED_FOLDER_ID ? untaggedCount : docs.length);

  const loading = showFolderGrid
    ? foldersQuery.isPending
    : docsEnabled && pageQuery.isPending;

  const selectFolder = (id: string) => {
    setSelectedFolder(id);
    setSearch("");
  };
  const changeGroupAxis = (axis: GroupAxis) => {
    setGroupAxis(axis);
    setSelectedFolder(ALL_FOLDER_ID);
    setSearch("");
  };

  const loadMore = () => {
    if (pageQuery.hasNextPage && !pageQuery.isFetchingNextPage) {
      void pageQuery.fetchNextPage();
    }
  };

  return (
    <AppWindow
      title="Documents"
      subtitle="Auto-saved task deliverables — agents can reference these later"
      onClose={onClose}
      defaultSize={{ w: 880, h: 600 }}
      minWidth={560}
      minHeight={360}
    >
      <div className="flex h-full min-h-0 overflow-hidden">
        <FinderSidebar
          folders={folders}
          selectedId={selectedFolder}
          allCount={total}
          untaggedCount={untaggedCount}
          groupAxis={groupAxis}
          onSelect={selectFolder}
          onGroupAxisChange={changeGroupAxis}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <FinderToolbar
            folderLabel={folderLabel}
            count={headerCount}
            search={search}
            viewMode={viewMode}
            onSearchChange={setSearch}
            onViewModeChange={setViewMode}
          />

          <div className="min-h-0 flex-1">
            {loading ? (
              <LoadingState />
            ) : showFolderGrid ? (
              <FinderFolderGrid
                folders={folders}
                untaggedCount={untaggedCount}
                onOpen={selectFolder}
              />
            ) : docs.length === 0 ? (
              <EmptyState
                icon={<span className="text-2xl">📄</span>}
                title="No documents"
                description={
                  searching
                    ? "Nothing matches that search."
                    : "This folder has no documents."
                }
              />
            ) : viewMode === "list" ? (
              <FinderListView
                docs={docs}
                onOpen={setActiveId}
                hasNextPage={pageQuery.hasNextPage}
                isFetchingNextPage={pageQuery.isFetchingNextPage}
                onLoadMore={loadMore}
              />
            ) : (
              <FinderGridView
                docs={docs}
                onOpen={setActiveId}
                hasNextPage={pageQuery.hasNextPage}
                isFetchingNextPage={pageQuery.isFetchingNextPage}
                onLoadMore={loadMore}
              />
            )}
          </div>
        </div>
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

/** Breadcrumb label for the active folder, resolving sentinels + derived labels. */
function labelForFolder(folderId: string, folders: FinderFolder[]): string {
  if (folderId === ALL_FOLDER_ID) return "All Documents";
  if (folderId === UNTAGGED_FOLDER_ID) return "Untagged";
  return folders.find((f) => f.id === folderId)?.label ?? folderId;
}
