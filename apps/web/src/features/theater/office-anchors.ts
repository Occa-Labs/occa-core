// Workstation registry — all chair+desk pairs detected in Demo.glb.
//
// Auto-derived by inspecting Demo.glb's scene graph: each entry pairs a
// chair (`SM_Prop_Chair_*`, excluding bean bags) with its nearest desk
// (`SM_Prop_Desk_<n>`) within 2.5 world units. Position is the chair's
// world-space center; rotationY is the angle facing the paired desk
// (computed as atan2(desk.x − chair.x, desk.z − chair.z)).
//
// To regenerate after modifying Demo.glb, re-run the inspect script:
//   node /tmp/inspect-glb.js   (or equivalent)
// then sync the values here. Source of truth is the GLB; this file is a
// snapshot for fast lookup at runtime without re-parsing 18MB on each
// scene mount.

export interface OfficeWorkstation {
  /** Stable id used by ROLE_LAYOUT to claim this workstation. */
  id: string;
  /** Spatial cluster label — useful for thematic grouping (departments). */
  cluster: WorkstationCluster;
  /** Functional category. `executive` = private/isolated chair reserved
   *  for managers; `work` = regular cubicle / open-desk seat at a real
   *  desk with monitor; `meeting` = chair around a conference table, not
   *  assigned to a single agent; `lobby` = reception / waiting chair
   *  with no desk; `lounge` = casual / relaxation seat. */
  kind: WorkstationKind;
  /** World-space chair position. */
  position: { x: number; y: number; z: number };
  /** Y-axis rotation (radians) so a character at this chair faces the desk. */
  rotationY: number;
  /** Source GLB node names — kept for traceability only. */
  chairName: string;
  deskName: string;
}

export type WorkstationKind =
  | "executive"
  | "work"
  | "meeting"
  | "lobby"
  | "lounge";

export type WorkstationCluster =
  | "home-office" // Isolated executive office (HomeOffice block, far -29 X)
  | "cubicle-pit" // Dev/engineering pit (4 stations clustered tightly)
  | "cubicle-back" // North edge of the cubicle pit (Chair_09 series, X -16..-19)
  | "meeting-desk" // Shared desk (Desk_03) with 2 chairs nearby
  | "boardroom" // Conference room with 7 chairs around a long table (far-right, X ~22)
  | "side-bay" // Side workstations (-11, 6..11)
  | "basement" // Below-grade floor (Y = -3)
  | "entry-row" // Near entrance door area (Z ≈ -8)
  | "open-desks" // Center open desk row (Desk_02 series)
  | "far-right" // Marketing/sales cluster (X ≥ 20)
  | "lobby" // Reception / waiting chairs near entry (X ~1, Z ~-6)
  | "lounge" // Casual lounge seating (X ~6, Z ~0)
  | "center-bay"; // Center workstations near the standing desk (X ~16, Z ~-3)

export const OFFICE_WORKSTATIONS: Record<string, OfficeWorkstation> = {
  // ── Home office ────────────────────────────────────────────────
  "home-office-1": {
    id: "home-office-1",
    cluster: "home-office",
    kind: "executive",
    position: { x: -29.15, y: 0, z: -4.05 },
    rotationY: -1.969,
    chairName: "SM_Prop_Chair_07 (6)",
    deskName: "SM_Prop_Desk_02 (4)",
  },

  // ── Cubicle pit (X -19..-10, Z -3..-1) ─────────────────────────
  "cubicle-pit-1": {
    id: "cubicle-pit-1",
    cluster: "cubicle-pit",
    kind: "work",
    position: { x: -18.18, y: 0, z: -3.46 },
    rotationY: -2.472,
    chairName: "SM_Prop_Chair_06 (1)",
    deskName: "SM_Prop_Desk_05 (1)",
  },
  "cubicle-pit-2": {
    id: "cubicle-pit-2",
    cluster: "cubicle-pit",
    kind: "work",
    position: { x: -15.95, y: 0, z: -1.57 },
    rotationY: 0.01,
    chairName: "SM_Prop_Chair_03",
    deskName: "SM_Prop_Desk_04 (1)",
  },
  "cubicle-pit-3": {
    id: "cubicle-pit-3",
    cluster: "cubicle-pit",
    kind: "work",
    position: { x: -14.55, y: 0, z: -3.61 },
    rotationY: -3.061,
    chairName: "SM_Prop_Chair_05 (3)",
    deskName: "SM_Prop_Desk_04 (2)",
  },
  "cubicle-pit-4": {
    id: "cubicle-pit-4",
    cluster: "cubicle-pit",
    kind: "work",
    position: { x: -10.94, y: -0.01, z: -2.52 },
    rotationY: 1.572,
    chairName: "SM_Prop_Chair_08",
    deskName: "SM_Prop_Desk_03",
  },

  // ── Cubicle back row (north of the pit) ────────────────────────
  "cubicle-back-1": {
    id: "cubicle-back-1",
    cluster: "cubicle-back",
    kind: "work",
    position: { x: -16.5, y: 0, z: 1.53 },
    rotationY: 2.904,
    chairName: "SM_Prop_Chair_09 (1)",
    deskName: "SM_Prop_Desk_04 (1)",
  },

  // ── Meeting desk (3 chairs around shared Desk_03) ──────────────
  "meeting-desk-1": {
    id: "meeting-desk-1",
    cluster: "meeting-desk",
    kind: "meeting",
    position: { x: -8.28, y: 0, z: -1.76 },
    rotationY: -2.02,
    chairName: "SM_Prop_Chair_01",
    deskName: "SM_Prop_Desk_03",
  },
  "meeting-desk-2": {
    id: "meeting-desk-2",
    cluster: "meeting-desk",
    kind: "meeting",
    position: { x: -8.33, y: 0, z: -3.31 },
    rotationY: -1.096,
    chairName: "SM_Prop_Chair_01 (1)",
    deskName: "SM_Prop_Desk_03",
  },

  // ── Side bay (single workstation at -11, 11) ───────────────────
  "side-bay-1": {
    id: "side-bay-1",
    cluster: "side-bay",
    kind: "lobby",
    position: { x: -11.25, y: 0, z: 11.0 },
    rotationY: 1.326,
    chairName: "SM_Prop_Chair_05",
    deskName: "SM_Prop_Desk_06",
  },

  // ── Basement (below-grade Y = -3) ──────────────────────────────
  "basement-1": {
    id: "basement-1",
    cluster: "basement",
    kind: "work",
    position: { x: -3.55, y: -3.01, z: 10.95 },
    rotationY: 0.022,
    chairName: "SM_Prop_Chair_05 (6)",
    deskName: "SM_Prop_Desk_04 (3)",
  },

  // ── Entry row (near entrance, Z ≈ -8) ──────────────────────────
  "entry-row-1": {
    id: "entry-row-1",
    cluster: "entry-row",
    kind: "work",
    position: { x: 9.34, y: 0, z: -8.15 },
    rotationY: 1.889,
    chairName: "SM_Prop_Chair_01 (2)",
    deskName: "SM_Prop_Desk_01",
  },
  "entry-row-2": {
    id: "entry-row-2",
    cluster: "entry-row",
    kind: "work",
    position: { x: 10.62, y: 0, z: -8.83 },
    rotationY: 1.618,
    chairName: "SM_Prop_Chair_07",
    deskName: "SM_Prop_Desk_01",
  },

  // ── Open desks (center, Desk_02 row) ───────────────────────────
  "open-desks-1": {
    id: "open-desks-1",
    cluster: "open-desks",
    kind: "work",
    position: { x: 13.94, y: 0, z: 5.88 },
    rotationY: -0.464,
    chairName: "SM_Prop_Chair_07 (3)",
    deskName: "SM_Prop_Desk_02 (1)",
  },
  "open-desks-2": {
    id: "open-desks-2",
    cluster: "open-desks",
    kind: "work",
    position: { x: 13.75, y: 0, z: 8.75 },
    rotationY: -2.684,
    chairName: "SM_Prop_Chair_03 (1)",
    deskName: "SM_Prop_Desk_02 (3)",
  },
  "open-desks-3": {
    id: "open-desks-3",
    cluster: "open-desks",
    kind: "work",
    position: { x: 14.0, y: 0, z: 11.25 },
    rotationY: -0.986,
    chairName: "SM_Prop_Chair_04 (8)",
    deskName: "SM_Prop_Desk_02",
  },
  "open-desks-4": {
    id: "open-desks-4",
    cluster: "open-desks",
    kind: "work",
    position: { x: 13.98, y: 0, z: 13.92 },
    rotationY: -2.453,
    chairName: "SM_Prop_Chair_05 (4)",
    deskName: "SM_Prop_Desk_02 (2)",
  },

  // ── Boardroom (conference room, 7 chairs around a long table at X ~22) ─
  "boardroom-1": {
    id: "boardroom-1",
    cluster: "boardroom",
    kind: "meeting",
    position: { x: 20.51, y: 0, z: 2.0 },
    rotationY: 2.954,
    chairName: "SM_Prop_Chair_04 (6)",
    deskName: "(boardroom table)",
  },
  "boardroom-2": {
    id: "boardroom-2",
    cluster: "boardroom",
    kind: "meeting",
    position: { x: 22.74, y: 0, z: 2.1 },
    rotationY: -2.903,
    chairName: "SM_Prop_Chair_04 (5)",
    deskName: "(boardroom table)",
  },
  "boardroom-3": {
    id: "boardroom-3",
    cluster: "boardroom",
    kind: "meeting",
    position: { x: 21.63, y: 0, z: 2.07 },
    rotationY: -3.064,
    chairName: "SM_Prop_Chair_04 (4)",
    deskName: "(boardroom table)",
  },
  "boardroom-4": {
    id: "boardroom-4",
    cluster: "boardroom",
    kind: "meeting",
    position: { x: 24.26, y: 0, z: 0.49 },
    rotationY: -1.309,
    chairName: "SM_Prop_Chair_04 (3)",
    deskName: "(boardroom table)",
  },
  "boardroom-5": {
    id: "boardroom-5",
    cluster: "boardroom",
    kind: "meeting",
    position: { x: 20.55, y: 0, z: -1.0 },
    rotationY: 0.216,
    chairName: "SM_Prop_Chair_04 (2)",
    deskName: "(boardroom table)",
  },
  "boardroom-6": {
    id: "boardroom-6",
    cluster: "boardroom",
    kind: "meeting",
    position: { x: 22.75, y: 0, z: -1.01 },
    rotationY: -0.317,
    chairName: "SM_Prop_Chair_04 (1)",
    deskName: "(boardroom table)",
  },
  "boardroom-7": {
    id: "boardroom-7",
    cluster: "boardroom",
    kind: "meeting",
    position: { x: 21.65, y: 0, z: -1.06 },
    rotationY: 0.0,
    chairName: "SM_Prop_Chair_04",
    deskName: "(boardroom table)",
  },

  // ── Far-right cluster (marketing/sales, X ≥ 20) ────────────────
  "far-right-1": {
    id: "far-right-1",
    cluster: "far-right",
    kind: "work",
    position: { x: 22.75, y: 0, z: 9.25 },
    rotationY: -2.897,
    chairName: "SM_Prop_Chair_07 (5)",
    deskName: "SM_Prop_Desk_01 (4)",
  },
  "far-right-2": {
    id: "far-right-2",
    cluster: "far-right",
    kind: "work",
    position: { x: 20.44, y: 0, z: 10.69 },
    rotationY: 0.008,
    chairName: "SM_Prop_Chair_07 (4)",
    deskName: "SM_Prop_Desk_04",
  },
  "far-right-3": {
    id: "far-right-3",
    cluster: "far-right",
    kind: "work",
    position: { x: 22.5, y: 0, z: 11.39 },
    rotationY: 3.07,
    chairName: "SM_Prop_Chair_05 (5)",
    deskName: "SM_Prop_Desk_01 (3)",
  },
  "far-right-4": {
    id: "far-right-4",
    cluster: "far-right",
    kind: "work",
    position: { x: 22.26, y: 0, z: 13.29 },
    rotationY: 2.943,
    chairName: "SM_Prop_Chair_06",
    deskName: "SM_Prop_Desk_01 (1)",
  },
  "far-right-5": {
    id: "far-right-5",
    cluster: "far-right",
    kind: "work",
    position: { x: 19.75, y: 0, z: 9.0 },
    rotationY: 1.711,
    chairName: "SM_Prop_Chair_04 (9)",
    deskName: "SM_Prop_Desk_04",
  },

  // ── Cubicle back (Chair_09 series, north of pit, X -16..-19) ───
  "cubicle-back-2": {
    id: "cubicle-back-2",
    cluster: "cubicle-back",
    kind: "work",
    position: { x: -16.1, y: 0, z: 3.16 },
    rotationY: -2.287,
    chairName: "SM_Prop_Chair_09 (8)",
    deskName: "SM_Prop_Desk_04 (1)",
  },
  "cubicle-back-3": {
    id: "cubicle-back-3",
    cluster: "cubicle-back",
    kind: "work",
    position: { x: -17.14, y: 0, z: 6.79 },
    rotationY: 2.086,
    chairName: "SM_Prop_Chair_09 (7)",
    deskName: "SM_Prop_Desk_04 (1)",
  },
  "cubicle-back-4": {
    id: "cubicle-back-4",
    cluster: "cubicle-back",
    kind: "work",
    position: { x: -16.63, y: 0, z: 5.42 },
    rotationY: 0.151,
    chairName: "SM_Prop_Chair_09 (6)",
    deskName: "SM_Prop_Desk_04 (1)",
  },
  "cubicle-back-5": {
    id: "cubicle-back-5",
    cluster: "cubicle-back",
    kind: "work",
    position: { x: -19.1, y: 0, z: 4.14 },
    rotationY: 0.151,
    chairName: "SM_Prop_Chair_09 (5)",
    deskName: "SM_Prop_Desk_04 (1)",
  },
  "cubicle-back-6": {
    id: "cubicle-back-6",
    cluster: "cubicle-back",
    kind: "work",
    position: { x: -19.35, y: 0, z: 5.98 },
    rotationY: -3.036,
    chairName: "SM_Prop_Chair_09 (4)",
    deskName: "SM_Prop_Desk_04 (1)",
  },
  "cubicle-back-7": {
    id: "cubicle-back-7",
    cluster: "cubicle-back",
    kind: "work",
    position: { x: -19.06, y: 0, z: 1.93 },
    rotationY: 2.681,
    chairName: "SM_Prop_Chair_09 (3)",
    deskName: "SM_Prop_Desk_04 (1)",
  },
  "cubicle-back-8": {
    id: "cubicle-back-8",
    cluster: "cubicle-back",
    kind: "work",
    position: { x: -17.9, y: 0, z: 0.85 },
    rotationY: -1.307,
    chairName: "SM_Prop_Chair_09 (2)",
    deskName: "SM_Prop_Desk_04 (1)",
  },
  "cubicle-back-9": {
    id: "cubicle-back-9",
    cluster: "cubicle-back",
    kind: "work",
    position: { x: -17.56, y: 0, z: 2.75 },
    rotationY: 2.114,
    chairName: "SM_Prop_Chair_09",
    deskName: "SM_Prop_Desk_04 (1)",
  },

  // ── Side bay (extra chairs at X ~-11, Z ~6.7) ──────────────────
  "side-bay-2": {
    id: "side-bay-2",
    cluster: "side-bay",
    kind: "lounge",
    position: { x: -10.18, y: 0, z: 6.67 },
    rotationY: -2.861,
    chairName: "SM_Prop_Chair_04 (7)",
    deskName: "SM_Prop_Desk_06",
  },
  "side-bay-3": {
    id: "side-bay-3",
    cluster: "side-bay",
    kind: "lounge",
    position: { x: -12.45, y: 0, z: 6.78 },
    rotationY: 2.568,
    chairName: "SM_Prop_Chair_07 (2)",
    deskName: "SM_Prop_Desk_06",
  },

  // ── Lobby (reception chairs near entry, X ~1, Z ~-6) ───────────
  "lobby-1": {
    id: "lobby-1",
    cluster: "lobby",
    kind: "lobby",
    position: { x: 0.13, y: 0, z: -5.46 },
    rotationY: 2.169,
    chairName: "SM_Prop_Chair_01 (4)",
    deskName: "(lobby)",
  },
  "lobby-2": {
    id: "lobby-2",
    cluster: "lobby",
    kind: "lobby",
    position: { x: 1.79, y: 0, z: -6.54 },
    rotationY: -0.358,
    chairName: "SM_Prop_Chair_01 (3)",
    deskName: "(lobby)",
  },

  // ── Entry row extra (Chair_11 standing-desk-adjacent) ──────────
  "entry-row-3": {
    id: "entry-row-3",
    cluster: "entry-row",
    kind: "work",
    position: { x: 11.23, y: 0, z: -5.25 },
    rotationY: -0.846,
    chairName: "SM_Prop_Chair_11 (2)",
    deskName: "SM_Prop_Desk_Standing_01",
  },

  // ── Lounge (3 casual chairs at X ~6, Z ~0.5) ───────────────────
  "lounge-1": {
    id: "lounge-1",
    cluster: "lounge",
    kind: "lounge",
    position: { x: 6.11, y: 0, z: 0.51 },
    rotationY: -3.025,
    chairName: "SM_Prop_Chair_11 (3)",
    deskName: "(lounge table)",
  },
  "lounge-2": {
    id: "lounge-2",
    cluster: "lounge",
    kind: "lounge",
    position: { x: 6.78, y: 0, z: 0.51 },
    rotationY: -1.473,
    chairName: "SM_Prop_Chair_11 (1)",
    deskName: "(lounge table)",
  },
  "lounge-3": {
    id: "lounge-3",
    cluster: "lounge",
    kind: "lounge",
    position: { x: 5.43, y: 0, z: 0.46 },
    rotationY: 0.764,
    chairName: "SM_Prop_Chair_11",
    deskName: "(lounge table)",
  },

  // ── Center bay (2 chairs near standing desk, X ~16, Z ~-3) ─────
  "center-bay-1": {
    id: "center-bay-1",
    cluster: "center-bay",
    kind: "work",
    position: { x: 15.88, y: 0, z: -2.65 },
    rotationY: -2.276,
    chairName: "SM_Prop_Chair_05 (2)",
    deskName: "SM_Prop_Desk_Standing_01",
  },
  "center-bay-2": {
    id: "center-bay-2",
    cluster: "center-bay",
    kind: "work",
    position: { x: 15.84, y: 0, z: -3.92 },
    rotationY: -0.839,
    chairName: "SM_Prop_Chair_05 (1)",
    deskName: "SM_Prop_Desk_Standing_01",
  },
};

/** Lookup helper. Throws on unknown id so typos surface at boot, not at
 *  render time (silent missing layout would just hide the agent). */
export function findWorkstation(id: string): OfficeWorkstation {
  const ws = OFFICE_WORKSTATIONS[id];
  if (!ws) {
    throw new Error(
      `Workstation "${id}" not found in OFFICE_WORKSTATIONS — check features/theater/office-anchors.ts`,
    );
  }
  return ws;
}
