"use client";

import { cn } from "@/lib/utils";
import type { FinderFolder } from "../../types";
import { UNTAGGED_FOLDER_ID } from "../../types";
import { Folder, folderGroupHover } from "./folder";

interface FinderFolderGridProps {
  folders: FinderFolder[];
  untaggedCount: number;
  onOpen: (id: string) => void;
}

/** Muted slate for the catch-all "Untagged" folder, set apart from tag folders. */
const UNTAGGED_COLOR = "#6b7280";

/**
 * The root view of the finder: tag folders rendered as animated folder tiles,
 * plus an "Untagged" tile when bare documents exist. Clicking a tile enters
 * that folder.
 */
export function FinderFolderGrid({
  folders,
  untaggedCount,
  onOpen,
}: FinderFolderGridProps) {
  return (
    <div className="grid h-full grid-cols-[repeat(auto-fill,minmax(124px,1fr))] content-start justify-items-center gap-x-4 gap-y-6 overflow-y-auto p-5">
      {folders.map((folder) => (
        <FolderTile
          key={folder.id}
          label={folder.label}
          count={folder.count}
          onOpen={() => onOpen(folder.id)}
        />
      ))}
      {untaggedCount > 0 && (
        <FolderTile
          label="Untagged"
          count={untaggedCount}
          color={UNTAGGED_COLOR}
          onOpen={() => onOpen(UNTAGGED_FOLDER_ID)}
        />
      )}
    </div>
  );
}

function FolderTile({
  label,
  count,
  color,
  onOpen,
}: {
  label: string;
  count: number;
  color?: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        folderGroupHover,
        "flex w-full cursor-pointer flex-col items-center gap-2 rounded-lg p-2",
      )}
    >
      <Folder color={color} size={0.78} />
      <span className="mt-1 max-w-full truncate text-xs font-medium text-white/85">
        {label}
      </span>
      <span className="text-[10px] text-white/35">
        {count} {count === 1 ? "item" : "items"}
      </span>
    </button>
  );
}
