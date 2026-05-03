// Idle pool: where agents go when their activity state = idle (no active
// task). Status `working` / `talking` keeps the agent at their desk; `idle`
// routes them here to look alive instead of all 28 of them frozen at empty
// keyboards. `meeting` routes to a boardroom seat.
//
// Pool composition (14 spots):
//   - 5 lounge / lobby existing chairs           (sit)
//   - 3 rec-area couches                         (sit)
//   - 4 lounge / lobby virtual standing anchors  (stand)
//   - 2 rec-area standing anchors                (stand, near foosball + TV)
//
// Assignment is deterministic per agent via claim-and-skip: agents are
// sorted by createdAt + id, then iterate the pool taking the first
// unclaimed spot. With ≤14 idle agents, every seat is unique. Beyond that
// we recycle from the start — collisions are unavoidable, but evenly
// spread instead of clustered on the same hash bucket.

export interface IdleAnchor {
  id: string;
  position: { x: number; y: number; z: number };
  rotationY: number;
  posture: "sit" | "stand";
}

// Sitting pool — sofa / couch / armchair positions captured via the dev
// "Map" tab in `sit` mode. Coordinates land on 0.5-unit cell centers;
// rotationY set by the second click during painting.
const SIT_POOL: readonly IdleAnchor[] = [
  { id: "sit-1", position: { x: -4.25, y: 0, z: -2.25 }, rotationY:  1.571, posture: "sit" },
  { id: "sit-2", position: { x: -5.75, y: 0, z: 13.75 }, rotationY: -1.571, posture: "sit" },
  { id: "sit-3", position: { x: -5.75, y: 0, z: 14.75 }, rotationY: -1.571, posture: "sit" },
  { id: "sit-4", position: { x:  2.25, y: 0, z:  0.75 }, rotationY: -1.571, posture: "sit" },
  { id: "sit-5", position: { x:  2.25, y: 0, z: -0.25 }, rotationY: -1.571, posture: "sit" },
  { id: "sit-6", position: { x:  2.25, y: 0, z: -1.25 }, rotationY: -1.571, posture: "sit" },
  { id: "sit-7", position: { x:  2.25, y: 0, z: -2.25 }, rotationY: -1.571, posture: "sit" },
  { id: "sit-8", position: { x: -3.75, y: 0, z:  4.25 }, rotationY:  3.142, posture: "sit" },
  { id: "sit-9", position: { x: -2.75, y: 0, z:  4.25 }, rotationY:  3.142, posture: "sit" },
];

// Standing pool — open-floor positions captured via the dev "Map" tab
// (see [components/dev/floor-grid.tsx]). Coordinates land on 0.5-unit
// cell centers; rotationY is set by the second click during painting.
const STAND_POOL: readonly IdleAnchor[] = [
  { id: "stand-1",  position: { x: -6.25, y: 0, z:  6.75 }, rotationY:  2.356, posture: "stand" },
  { id: "stand-2",  position: { x: -6.25, y: 0, z:  5.75 }, rotationY:  0.785, posture: "stand" },
  { id: "stand-3",  position: { x:  8.25, y: 0, z: -4.25 }, rotationY:  1.571, posture: "stand" },
  { id: "stand-4",  position: { x:  4.75, y: 0, z: -0.75 }, rotationY:  1.571, posture: "stand" },
  { id: "stand-5",  position: { x:  4.75, y: 0, z: -1.75 }, rotationY:  1.571, posture: "stand" },
  { id: "stand-6",  position: { x:  4.75, y: 0, z: -2.75 }, rotationY:  1.107, posture: "stand" },
  { id: "stand-7",  position: { x:  5.75, y: 0, z: -3.25 }, rotationY:  0.000, posture: "stand" },
  { id: "stand-8",  position: { x:  7.75, y: 0, z: -3.25 }, rotationY: -0.785, posture: "stand" },
  { id: "stand-9",  position: { x:  7.75, y: 0, z: -2.25 }, rotationY: -1.571, posture: "stand" },
  { id: "stand-10", position: { x:  7.75, y: 0, z: -1.25 }, rotationY: -1.571, posture: "stand" },
];

// Full pool in claim order. STAND anchors come first — these are the
// hand-painted casual hangout positions (kitchen counter, foosball,
// lounge edges) and reading them as the primary idle surface matches
// the dev's mental model: when an agent is "idle", they walked away
// from their desk to a standing spot. SIT anchors (lounge/lobby/couch
// chairs) are the fallback when the stand pool is fully claimed.
const IDLE_POOL: readonly IdleAnchor[] = [...STAND_POOL, ...SIT_POOL];

// Stable agent sort key — same convention as `buildAgentModelMap` so the
// two assignments don't drift when the agent list reorders.
function sortAgents<T extends { id: string; createdAt?: string }>(
  agents: readonly T[],
): T[] {
  return [...agents].sort((a, b) => {
    const ca = a.createdAt ?? "";
    const cb = b.createdAt ?? "";
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

// Build a stable agentId → IdleAnchor map. Claim-and-skip over the pool;
// when the pool is exhausted we recycle from the start (collisions evenly
// spread across the pool instead of clumping on one anchor).
export function buildIdleAssignments(
  agents: readonly { id: string; createdAt?: string }[],
): Map<string, IdleAnchor> {
  const sorted = sortAgents(agents);
  const map = new Map<string, IdleAnchor>();
  sorted.forEach((a, i) => {
    map.set(a.id, IDLE_POOL[i % IDLE_POOL.length]);
  });
  return map;
}

// Boardroom routing: agents in `status=meeting` round-robin across the 7
// boardroom chairs in createdAt order, identical sort key to the idle map.
const BOARDROOM_SEATS = [
  "boardroom-1",
  "boardroom-2",
  "boardroom-3",
  "boardroom-4",
  "boardroom-5",
  "boardroom-6",
  "boardroom-7",
] as const;

export function buildBoardroomAssignments(
  agents: readonly { id: string; createdAt?: string }[],
): Map<string, string> {
  const sorted = sortAgents(agents);
  const map = new Map<string, string>();
  sorted.forEach((a, i) => {
    map.set(a.id, BOARDROOM_SEATS[i % BOARDROOM_SEATS.length]);
  });
  return map;
}
