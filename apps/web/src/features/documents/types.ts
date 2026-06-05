/** Finder UI types — shared across the finder components + utils. */

/** How the main pane lays documents out. */
export type FinderViewMode = "list" | "grid";

/** Which axis the sidebar folders group documents by. */
export type GroupAxis = "tags" | "date";

/**
 * A sidebar folder. Today every folder is derived from a tag (no real folder
 * hierarchy in the DB), so `id` doubles as the tag used to filter documents.
 */
export interface FinderFolder {
  id: string;
  label: string;
  count: number;
}

/** Sentinel folder id for "show everything", no tag filter. */
export const ALL_FOLDER_ID = "__all__";

/** Sentinel folder id for documents that carry no tags. */
export const UNTAGGED_FOLDER_ID = "__untagged__";
