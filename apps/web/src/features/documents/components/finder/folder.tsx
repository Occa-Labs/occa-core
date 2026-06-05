"use client";

import { cn } from "@/lib/utils";
import styles from "./folder.module.css";

interface FolderProps {
  /** Back + tab color. The front leaf is derived a shade lighter. */
  color?: string;
  /** Native width is 100px; `size` scales the whole folder proportionally. */
  size?: number;
  className?: string;
}

/**
 * Pure animated folder visual. Hovering the folder (or any ancestor carrying
 * the exported `folderGroupHover` class) lifts it and splays the leaves.
 * Stateless and reusable anywhere a folder icon is needed.
 */
export function Folder({ color = "#4786ff", size = 1, className }: FolderProps) {
  return (
    <div
      className={cn(styles.folder, className)}
      style={
        {
          "--folder-color": color,
          "--folder-w": `${100 * size}px`,
        } as React.CSSProperties
      }
    >
      <div className={styles.back}>
        <div className={styles.paper} />
        <div className={styles.paper} />
        <div className={styles.paper} />
        <div className={styles.front} />
        <div className={cn(styles.front, styles.right)} />
      </div>
    </div>
  );
}

/**
 * Apply to a wrapping element (e.g. a button) so its hover drives the folder
 * animation, letting the whole tile be the hover/click target.
 */
export const folderGroupHover = styles.groupHover;
