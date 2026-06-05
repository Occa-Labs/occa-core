"use client";

import { Calendar, FileQuestion, Files, Hash } from "lucide-react";
import { surface } from "@/components/ui/tokens";
import { cn } from "@/lib/utils";
import type { FinderFolder, GroupAxis } from "../../types";
import { ALL_FOLDER_ID, UNTAGGED_FOLDER_ID } from "../../types";

interface FinderSidebarProps {
  folders: FinderFolder[];
  selectedId: string;
  allCount: number;
  untaggedCount: number;
  groupAxis: GroupAxis;
  onSelect: (id: string) => void;
  onGroupAxisChange: (axis: GroupAxis) => void;
}

/**
 * Left rail of the finder. A pinned "All Documents" root, a group-by switcher,
 * then the derived folders for the active axis (tags or dates). Folders carry
 * no real hierarchy in the DB — they are computed views.
 */
export function FinderSidebar({
  folders,
  selectedId,
  allCount,
  untaggedCount,
  groupAxis,
  onSelect,
  onGroupAxisChange,
}: FinderSidebarProps) {
  const isTags = groupAxis === "tags";
  const showUntagged = isTags && untaggedCount > 0;

  return (
    <aside
      className="flex w-48 shrink-0 flex-col gap-3 p-3"
      style={surface.recessed}
    >
      {/* Pinned controls — stay put while the folder list below scrolls. */}
      <div className="flex shrink-0 flex-col gap-3">
        <SidebarRow
          icon={<Files className="size-4" />}
          label="All Documents"
          count={allCount}
          active={selectedId === ALL_FOLDER_ID}
          onClick={() => onSelect(ALL_FOLDER_ID)}
        />
        <GroupAxisToggle axis={groupAxis} onChange={onGroupAxisChange} />
      </div>

      {(folders.length > 0 || showUntagged) && (
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-white/30">
            {isTags ? "Tags" : "Dates"}
          </p>
          {folders.map((folder) => (
            <SidebarRow
              key={folder.id}
              icon={
                isTags ? (
                  <Hash className="size-4" />
                ) : (
                  <Calendar className="size-4" />
                )
              }
              label={folder.label}
              count={folder.count}
              active={selectedId === folder.id}
              onClick={() => onSelect(folder.id)}
            />
          ))}
          {showUntagged && (
            <SidebarRow
              icon={<FileQuestion className="size-4" />}
              label="Untagged"
              count={untaggedCount}
              active={selectedId === UNTAGGED_FOLDER_ID}
              onClick={() => onSelect(UNTAGGED_FOLDER_ID)}
            />
          )}
        </div>
      )}
    </aside>
  );
}

function GroupAxisToggle({
  axis,
  onChange,
}: {
  axis: GroupAxis;
  onChange: (axis: GroupAxis) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="px-2 text-[10px] font-medium uppercase tracking-wider text-white/30">
        Group by
      </p>
      <div className="flex gap-0.5 rounded-md bg-white/5 p-0.5">
        <AxisButton active={axis === "tags"} onClick={() => onChange("tags")}>
          Tags
        </AxisButton>
        <AxisButton active={axis === "date"} onClick={() => onChange("date")}>
          Date
        </AxisButton>
      </div>
    </div>
  );
}

function AxisButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 cursor-pointer rounded px-2 py-1 text-xs transition",
        active
          ? "bg-white/15 text-white"
          : "text-white/45 hover:text-white/80",
      )}
    >
      {children}
    </button>
  );
}

function SidebarRow({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition",
        active
          ? "bg-white/15 text-white"
          : "text-white/60 hover:bg-white/5 hover:text-white/90",
      )}
    >
      <span className="shrink-0 text-white/40">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      <span className="shrink-0 text-xs text-white/30">{count}</span>
    </button>
  );
}
