// Dev-only "map editor" store. Holds mapping mode + the user-painted
// cells used as data for the hardcoded idle pools. Module-level state
// with `useSyncExternalStore` so the dev-tools tab and the 3D FloorGrid
// component (different parts of the React tree) stay in sync without
// prop drilling.
//
// Persisted cells live in localStorage under `occa.dev.map`. Mode +
// pending state are session-only — re-mounting starts fresh in `off`.
//
// This is a dev surface; no zustand dep needed for one tiny store.

import { useSyncExternalStore } from "react";

export type MapKind = "stand" | "sit";

export interface MapCell {
  /** Grid cell center, integer world units. */
  x: number;
  z: number;
  /** Y-axis rotation in radians, set on the second click (facing target). */
  rotationY: number;
  /** Which idle pool this cell will end up in once copied to code. */
  kind: MapKind;
}

export type MapMode = "off" | MapKind;

interface DevMapState {
  mode: MapMode;
  cells: MapCell[];
  /** First-click position, awaiting a second click to set facing. */
  pending: { x: number; z: number } | null;
}

const STORAGE_KEY = "occa.dev.map";

function loadInitial(): DevMapState {
  if (typeof window === "undefined") {
    return { mode: "off", cells: [], pending: null };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { mode: "off", cells: [], pending: null };
    const parsed = JSON.parse(raw) as {
      cells?: Array<{ x: number; z: number; rotationY: number; kind?: MapKind }>;
    };
    // Backward compat: cells saved before the `kind` field existed are
    // assumed to be stand-pool entries (the only mode that existed then).
    const cells: MapCell[] = Array.isArray(parsed.cells)
      ? parsed.cells.map((c) => ({
          x: c.x,
          z: c.z,
          rotationY: c.rotationY,
          kind: c.kind ?? "stand",
        }))
      : [];
    return { mode: "off", cells, pending: null };
  } catch {
    return { mode: "off", cells: [], pending: null };
  }
}

let state: DevMapState = loadInitial();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function persist() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ cells: state.cells }));
  } catch {
    /* quota / private mode — dev-only, ignore */
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getSnapshot = () => state;

export function useDevMap(): DevMapState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Imperative actions — called from dev tab + floor-grid handlers.
export const devMapActions = {
  setMode(mode: MapMode) {
    state = { ...state, mode, pending: null };
    notify();
  },

  // First click: stage the position. If the same cell already has a saved
  // entry, treat the click as a delete (toggle off). If a pending exists,
  // a click on the same cell cancels.
  startOrToggle(x: number, z: number) {
    if (state.pending && state.pending.x === x && state.pending.z === z) {
      state = { ...state, pending: null };
      notify();
      return;
    }
    if (!state.pending) {
      // Toggle-delete: only matches a cell of the *current* kind so the
      // user can't accidentally wipe their stand pool while painting sit
      // (and vice versa).
      const kind = state.mode === "off" ? null : state.mode;
      const existing = state.cells.findIndex(
        (c) => c.x === x && c.z === z && (kind === null || c.kind === kind),
      );
      if (existing >= 0) {
        state = {
          ...state,
          cells: state.cells.filter((_, i) => i !== existing),
        };
        persist();
        notify();
        return;
      }
      if (kind === null) return; // No mode active — no-op.
      state = { ...state, pending: { x, z } };
      notify();
      return;
    }
    if (state.mode === "off") {
      // Mode flipped off mid-pending — drop pending, do nothing.
      state = { ...state, pending: null };
      notify();
      return;
    }
    // Pending exists, target is a different cell — commit with facing.
    const dx = x - state.pending.x;
    const dz = z - state.pending.z;
    const rotationY = Math.atan2(dx, dz);
    state = {
      ...state,
      cells: [
        ...state.cells,
        { x: state.pending.x, z: state.pending.z, rotationY, kind: state.mode },
      ],
      pending: null,
    };
    persist();
    notify();
  },

  clearKind(kind: MapKind) {
    state = {
      ...state,
      cells: state.cells.filter((c) => c.kind !== kind),
      pending: null,
    };
    persist();
    notify();
  },

  cancelPending() {
    if (!state.pending) return;
    state = { ...state, pending: null };
    notify();
  },
};

// Format saved cells of a given kind as a TypeScript array literal for
// pasting into idle-anchors.ts (STAND_POOL or SIT_POOL).
export function exportCellsAsCode(
  cells: readonly MapCell[],
  kind: MapKind,
): string {
  const subset = cells.filter((c) => c.kind === kind);
  if (subset.length === 0) return `// (no ${kind} cells saved)`;
  const constName = kind === "stand" ? "STAND_POOL" : "SIT_POOL";
  const idPrefix = kind;
  const lines = subset.map(
    (c, i) =>
      `  { id: "${idPrefix}-${i + 1}", position: { x: ${c.x}, y: 0, z: ${c.z} }, rotationY: ${c.rotationY.toFixed(3)}, posture: "${kind}" },`,
  );
  return `const ${constName}: readonly IdleAnchor[] = [\n${lines.join("\n")}\n];`;
}
