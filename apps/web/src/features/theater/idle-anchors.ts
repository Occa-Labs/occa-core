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
  {
    id: "sit-1",
    position: { x: -4.25, y: 0, z: -2.25 },
    rotationY: 1.571,
    posture: "sit",
  },
  {
    id: "sit-2",
    position: { x: -5.75, y: 0, z: 13.75 },
    rotationY: -1.571,
    posture: "sit",
  },
  {
    id: "sit-3",
    position: { x: -5.75, y: 0, z: 14.75 },
    rotationY: -1.571,
    posture: "sit",
  },
  {
    id: "sit-4",
    position: { x: 2.25, y: 0, z: 0.75 },
    rotationY: -1.571,
    posture: "sit",
  },
  {
    id: "sit-5",
    position: { x: 2.25, y: 0, z: -0.25 },
    rotationY: -1.571,
    posture: "sit",
  },
  {
    id: "sit-6",
    position: { x: 2.25, y: 0, z: -1.25 },
    rotationY: -1.571,
    posture: "sit",
  },
  {
    id: "sit-7",
    position: { x: 2.25, y: 0, z: -2.25 },
    rotationY: -1.571,
    posture: "sit",
  },
  {
    id: "sit-8",
    position: { x: -3.75, y: 0, z: 4.25 },
    rotationY: 3.142,
    posture: "sit",
  },
  {
    id: "sit-9",
    position: { x: -2.75, y: 0, z: 4.25 },
    rotationY: 3.142,
    posture: "sit",
  },
];

// Standing pool — open-floor positions captured via the dev "Map" tab
// (see [components/dev/floor-grid.tsx]). Coordinates land on 0.5-unit
// cell centers; rotationY is set by the second click during painting.
const STAND_POOL: readonly IdleAnchor[] = [
  {
    id: "stand-1",
    position: { x: -6.25, y: 0, z: 6.75 },
    rotationY: 2.356,
    posture: "stand",
  },
  {
    id: "stand-2",
    position: { x: -6.25, y: 0, z: 5.75 },
    rotationY: 0.785,
    posture: "stand",
  },
  {
    id: "stand-3",
    position: { x: 8.25, y: 0, z: -4.25 },
    rotationY: 1.571,
    posture: "stand",
  },
  {
    id: "stand-4",
    position: { x: 4.75, y: 0, z: -0.75 },
    rotationY: 1.571,
    posture: "stand",
  },
  {
    id: "stand-5",
    position: { x: 4.75, y: 0, z: -1.75 },
    rotationY: 1.571,
    posture: "stand",
  },
  {
    id: "stand-6",
    position: { x: 4.75, y: 0, z: -2.75 },
    rotationY: 1.107,
    posture: "stand",
  },
  {
    id: "stand-7",
    position: { x: 5.75, y: 0, z: -3.25 },
    rotationY: 0.0,
    posture: "stand",
  },
  {
    id: "stand-8",
    position: { x: 7.75, y: 0, z: -3.25 },
    rotationY: -0.785,
    posture: "stand",
  },
  {
    id: "stand-9",
    position: { x: 7.75, y: 0, z: -2.25 },
    rotationY: -1.571,
    posture: "stand",
  },
  {
    id: "stand-10",
    position: { x: 7.75, y: 0, z: -1.25 },
    rotationY: -1.571,
    posture: "stand",
  },
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

// How long an agent dwells at one idle anchor before rotating to a new
// pool slot. Long enough that the room feels lived-in (not a Vegas
// fountain), short enough that staring at one agent eventually shows
// movement. Per-agent phase below staggers the flips so the room
// doesn't reshuffle in lockstep.
const IDLE_DWELL_MS = 60_000;

// Cheap deterministic string hash (djb2-ish). Used for per-agent phase
// + permutation seed so the rotation looks random across agents but is
// stable for any given (agentId, epoch) pair.
function simpleHash(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// Build an agentId → IdleAnchor map that rotates over time. Each agent
// has its own dwell phase (offset by hash(id) so they flip at different
// moments) and re-rolls a desired pool index every IDLE_DWELL_MS.
// Claim-and-skip over the desired indices in createdAt order keeps two
// agents from ever stacking on the same anchor in the same epoch.
//
// `nowMs` is injected so the caller can drive a re-render via a state
// tick — the function itself is pure and deterministic for a given
// (agents, nowMs).
export function buildIdleAssignments(
  agents: readonly { id: string; createdAt?: string }[],
  nowMs: number = Date.now(),
): Map<string, IdleAnchor> {
  const sorted = sortAgents(agents);
  const claimed = new Set<number>();
  const map = new Map<string, IdleAnchor>();
  sorted.forEach((a) => {
    const idHash = simpleHash(a.id);
    // Per-agent phase offset → epoch boundaries don't align across the
    // roster, so flips look organic rather than a synchronized shuffle.
    const phaseMs = idHash % IDLE_DWELL_MS;
    const epoch = Math.floor((nowMs + phaseMs) / IDLE_DWELL_MS);
    // Desired index = hash(id, epoch) → uniformly distributed across pool.
    const seed = simpleHash(`${a.id}:${epoch}`);
    let idx = seed % IDLE_POOL.length;
    let tries = 0;
    while (claimed.has(idx) && tries < IDLE_POOL.length) {
      idx = (idx + 1) % IDLE_POOL.length;
      tries++;
    }
    claimed.add(idx);
    map.set(a.id, IDLE_POOL[idx]);
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
