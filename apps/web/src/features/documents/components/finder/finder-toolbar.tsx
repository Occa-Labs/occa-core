"use client";

import { ChevronRight, LayoutGrid, List, Search } from "lucide-react";
import { border } from "@/components/ui/tokens";
import { cn } from "@/lib/utils";
import type { FinderViewMode } from "../../types";

interface FinderToolbarProps {
  folderLabel: string;
  count: number;
  search: string;
  viewMode: FinderViewMode;
  onSearchChange: (value: string) => void;
  onViewModeChange: (mode: FinderViewMode) => void;
}

/**
 * Top bar of the main pane: a breadcrumb of the current folder + result count,
 * a search box, and the list/grid view toggle.
 */
export function FinderToolbar({
  folderLabel,
  count,
  search,
  viewMode,
  onSearchChange,
  onViewModeChange,
}: FinderToolbarProps) {
  return (
    <div
      className="flex items-center gap-3 px-3 py-2"
      style={{ borderBottom: border.divider }}
    >
      <div className="flex min-w-0 items-center gap-1 text-sm">
        <span className="shrink-0 text-white/40">Documents</span>
        <ChevronRight className="size-3.5 shrink-0 text-white/25" />
        <span className="truncate font-medium text-white/90">
          {folderLabel}
        </span>
        <span className="ml-1 shrink-0 text-xs text-white/30">{count}</span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-white/30" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search"
            className="h-7 w-40 rounded-md bg-white/5 pl-7 pr-2 text-xs text-white placeholder:text-white/30 outline-none transition focus:bg-white/10"
          />
        </div>

        <div className="flex items-center gap-0.5 rounded-md bg-white/5 p-0.5">
          <ViewToggleButton
            active={viewMode === "list"}
            label="List view"
            onClick={() => onViewModeChange("list")}
          >
            <List className="size-4" />
          </ViewToggleButton>
          <ViewToggleButton
            active={viewMode === "grid"}
            label="Grid view"
            onClick={() => onViewModeChange("grid")}
          >
            <LayoutGrid className="size-4" />
          </ViewToggleButton>
        </div>
      </div>
    </div>
  );
}

function ViewToggleButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "flex cursor-pointer items-center justify-center rounded p-1 transition",
        active
          ? "bg-white/15 text-white"
          : "text-white/40 hover:text-white/80",
      )}
    >
      {children}
    </button>
  );
}
