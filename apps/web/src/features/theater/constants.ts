import * as THREE from "three";
import { findWorkstation } from "./office-anchors";
import type { RoleLayout } from "./types";
import { CEO_DESK, assignSeat } from "@occa/shared/seating";
import { CEO_ROLE } from "@occa/shared/role-catalog";

// Animation URLs. Files MUST use the asset-pack rig — bone names like
// `Hips`, `Spine_01`, `Clavicle_L`, `Elbow_L`, etc., NO `mixamorig` prefix.
// Mixamo downloads work plug-and-play because the character was uploaded
// to Mixamo's Auto-Rigger with the asset-pack rig pre-named, so Mixamo
// preserved the bone vocabulary on output.
//
// Standing (guide character — Jia is always female):
export const STANDING_IDLE_ANIM = "/models/animations/StandingIdleFemale.fbx";
export const WALKING_ANIM = "/models/animations/WalkingFemale.fbx";

// Seated working / talking — single clip drives all genders.
export const TYPING_ANIM = "/models/animations/Typing.fbx";
export const SITTING_TALKING_ANIM = "/models/animations/SittingTalking.fbx";

// Seated idle has male / female variants — Mixamo's idle bias differs
// enough between the two that mixing looks off. Picked from the GLB
// filename (`*_male_*` / `*_female_*`).
export function sittingIdleAnimFor(modelUrl: string): string {
  return /_female_/.test(modelUrl)
    ? "/models/animations/SittingIdleFemale.fbx"
    : "/models/animations/SittingIdleMale.fbx";
}

// Standing idle for agents off-desk (idle pool stand anchors). Male
// variant carries a briefcase — only standing idle we have for males in
// the asset pack; visually OK in an office context.
export function standingIdleAnimFor(modelUrl: string): string {
  return /_female_/.test(modelUrl)
    ? "/models/animations/StandingIdleFemale.fbx"
    : "/models/animations/StandingIdleMaleBriefcase.fbx";
}

// Guide ("Jia") spawn / facing — she's not a hired agent so she lives outside
// ROLE_LAYOUT and keeps her own model + walk path.
export const GUIDE_POSITION = new THREE.Vector3(-11, 0, 20);
export const GUIDE_ROTATION_Y = Math.atan2(1, 4);
export const GUIDE_MODEL = "/models/characters/boss_female_01.glb";

// Per-role 3D character model — the *preferred* GLB for an agent of this
// role. The actual model used by an agent goes through the claim-and-skip
// algorithm in `buildAgentModelMap` below: if two roles map to the same
// GLB (or two agents share a role), the second one falls through to the
// next available model so characters stay visually distinct until the
// global pool is exhausted.
// `developer_male_02.glb` is intentionally NOT referenced anywhere — its
// material renders as a fully black silhouette in-scene (texture binding
// glitch on this specific GLB). Don't add it back without re-exporting
// the asset.
const ROLE_MODEL: Record<string, string> = {
  ceo: "/models/characters/business_male_04.glb",
  cto: "/models/characters/developer_male_01.glb",
  cmo: "/models/characters/business_female_02.glb",
  coo: "/models/characters/business_male_01.glb",
  cfo: "/models/characters/business_female_03.glb",
  chro: "/models/characters/boss_male_01.glb",
  head_engineering: "/models/characters/developer_female_02.glb",
  head_research: "/models/characters/business_male_02.glb",
  head_editorial: "/models/characters/business_female_04.glb",
  head_marketing: "/models/characters/business_female_01.glb",
  head_design: "/models/characters/developer_female_01.glb",
  managing_editor: "/models/characters/business_male_03.glb",
  senior_writer: "/models/characters/business_female_04.glb",
  onchain_analyst: "/models/characters/business_male_02.glb",
  solana_engineer: "/models/characters/developer_male_01.glb",
};

// Global model pool ordered for variety — alternating styles + genders so
// when claim-and-skip falls through, the next pick still visually contrasts
// the previous claim. Excluded:
//   - boss_female_01 — owned by the onboarding guide ("Jia"), see GUIDE_MODEL.
//   - developer_male_02 — renders as a black silhouette in-scene
//     (material/texture binding glitch on this specific GLB).
//   - cleaner_*, security_* — wrong vibe for an office tenant; no agent
//     role should look like janitorial / guard staff.
export const MODEL_POOL: readonly string[] = [
  "/models/characters/business_male_04.glb",
  "/models/characters/business_female_02.glb",
  "/models/characters/developer_male_01.glb",
  "/models/characters/developer_female_01.glb",
  "/models/characters/business_male_01.glb",
  "/models/characters/business_female_03.glb",
  "/models/characters/developer_female_02.glb",
  "/models/characters/business_male_02.glb",
  "/models/characters/business_female_04.glb",
  "/models/characters/business_male_03.glb",
  "/models/characters/business_female_01.glb",
  "/models/characters/boss_male_01.glb",
];

// Build a stable agentId → modelUrl map for the whole company. The same
// input list always produces the same map because we sort by createdAt
// (or id as tiebreaker) before claiming.
//
// Algorithm:
//   1. Sort agents by createdAt asc, id asc — deterministic order.
//   2. For each agent, take their ROLE_MODEL preference if not yet claimed.
//   3. Otherwise iterate MODEL_POOL and take the first unclaimed model.
//   4. If both fail (>17 agents), recycle from the start of MODEL_POOL —
//      duplicates only appear past the unique-pool ceiling.
//
// Visual goal: every agent looks distinct until the office hits ~17 hires.
export function buildAgentModelMap(
  agents: readonly {
    id: string;
    role: string;
    createdAt?: string;
    modelOverride?: string | null;
  }[],
): Map<string, string> {
  const sorted = [...agents].sort((a, b) => {
    const ca = a.createdAt ?? "";
    const cb = b.createdAt ?? "";
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  const claimed = new Set<string>();
  const map = new Map<string, string>();

  // Pass 1: lock in user-pinned overrides first so claim-and-skip doesn't
  // hand them out to someone else. An override is honoured even if it
  // duplicates another agent's auto-pick — explicit user choice wins.
  for (const a of sorted) {
    if (a.modelOverride) {
      claimed.add(a.modelOverride);
      map.set(a.id, a.modelOverride);
    }
  }

  for (const a of sorted) {
    if (map.has(a.id)) continue;
    const preferred = ROLE_MODEL[a.role];
    let picked: string | null = null;

    if (preferred && !claimed.has(preferred)) {
      picked = preferred;
    } else {
      for (const m of MODEL_POOL) {
        if (!claimed.has(m)) {
          picked = m;
          break;
        }
      }
    }

    // Pool exhausted (>17 unique agents). Recycle deterministically — fall
    // back to ROLE_MODEL preference (might dup), else first pool entry.
    if (!picked) picked = preferred ?? MODEL_POOL[0];

    claimed.add(picked);
    map.set(a.id, picked);
  }

  return map;
}

// Single-agent helper for camera-focus modes that don't have the full
// agents list at hand (kickoff cinematic targeting CEO, etc.). Returns
// the role's preferred model with no dedupe — only used for non-rendered
// "phantom" targets.
function modelUrlForRole(role: string): string {
  return ROLE_MODEL[role] ?? MODEL_POOL[0];
}

// Primary entry point: layout for a hired agent. Reads the seat the server
// assigned at hire time. Legacy rows pre-migration have a null
// workstationId — those fall back to a synchronous run of the seating
// algorithm against an empty `occupied` set, which gives them their home
// zone's first desk (deterministic and harmless: server backfills on next
// write).
//
// `modelOverride` is the model picked by `buildAgentModelMap` for this
// agent; pass it from the parent that has the full agents list. When
// omitted (camera-focus phantom paths), falls through to the role's
// preferred model with no dedupe.
export function getAgentLayout(
  agent: {
    role: string;
    workstationId: string | null;
  },
  modelOverride?: string,
): RoleLayout {
  const wsId =
    agent.workstationId ??
    assignSeat({ role: agent.role, occupied: new Set() }) ??
    CEO_DESK;
  const ws = findWorkstation(wsId);
  return {
    position: ws.position,
    rotationY: ws.rotationY,
    modelUrl: modelOverride ?? modelUrlForRole(agent.role),
  };
}

// Role-only fallback: used by camera-focus modes that don't have a specific
// agent yet (e.g. kickoff "meeting" cinematic targets the CEO before the
// row exists). Always returns the role's home-zone first seat.
export function getRoleLayout(role: string): RoleLayout {
  const wsId = assignSeat({ role, occupied: new Set() }) ?? CEO_DESK;
  const ws = findWorkstation(wsId);
  return {
    position: ws.position,
    rotationY: ws.rotationY,
    modelUrl: modelUrlForRole(role),
  };
}

const CEO_LAYOUT = getRoleLayout(CEO_ROLE);
export const CEO_POSITION = new THREE.Vector3(
  CEO_LAYOUT.position.x,
  CEO_LAYOUT.position.y,
  CEO_LAYOUT.position.z,
);

// Walk waypoint format. `rotationY` is the body facing the recorder
// captured (or that the player should snap to after arriving at this
// position). For paths recorded *before* rotation tracking landed, set
// rotationY to 0 — most consumers (guide-character) only read .position
// and auto-face the direction of motion anyway.
//
// `dialog` is optional narrator text Jia speaks when she reaches this
// waypoint during the room tour: she pauses, the line is shown in a
// bottom-sheet that auto-dismisses (no clicks). Marked from the dev
// recorder via the SPACE hotkey, then filled in manually.
//
// `t` is the elapsed time (ms) since the recording started. Playback
// won't advance past this waypoint until that much wall-clock time has
// passed since the tour began — preserves "stand still and look
// around" pauses captured during recording. Optional for paths
// captured before timing tracking landed; missing → no extra wait.
export interface Waypoint {
  position: THREE.Vector3;
  rotationY: number;
  dialog?: string;
  t?: number;
}

// Jia's walk path to the CEO desk. Update via the dev "Record" tab if
// layout changes. GuideCharacter reads only .position; .rotationY here
// is unused (Jia auto-faces the next waypoint while walking).
export const WALK_WAYPOINTS: readonly Waypoint[] = [
  { position: new THREE.Vector3(-11.0, 0, 20.0), rotationY: 0 },
  { position: new THREE.Vector3(-10.43, 0, 18.07), rotationY: 0 },
  { position: new THREE.Vector3(-10.33, 0, 16.06), rotationY: 0 },
  { position: new THREE.Vector3(-9.37, 0, 14.3), rotationY: 0 },
  { position: new THREE.Vector3(-8.4, 0, 12.54), rotationY: 0 },
  { position: new THREE.Vector3(-7.58, 0, 10.68), rotationY: 0 },
  { position: new THREE.Vector3(-7.22, 0, 8.69), rotationY: 0 },
  { position: new THREE.Vector3(-7.05, 0, 6.68), rotationY: 0 },
  { position: new THREE.Vector3(-6.37, 0, 4.79), rotationY: 0 },
  { position: new THREE.Vector3(-5.38, 0, 3.05), rotationY: 0 },
  { position: new THREE.Vector3(-3.58, 0, 2.17), rotationY: 0 },
];

export const WALK_SPEED = 1.8; // world units/s
export const ARRIVE_THRESHOLD = 0.7; // final waypoint
export const WP_THRESHOLD = 1.2; // intermediate waypoints

// Camera positions & lerp factors
export const ONBOARDING_CAM_POS = new THREE.Vector3(-10, 2.5, 24);
export const ONBOARDING_CAM_TARGET = new THREE.Vector3(
  GUIDE_POSITION.x,
  1.5,
  GUIDE_POSITION.z,
);
export const OVERVIEW_CAM_POS = new THREE.Vector3(30, 25, 30);
export const OVERVIEW_CAM_TARGET = new THREE.Vector3(0, 0, 5);

// Agent-focus camera framing — derived per-agent from RoleLayout. The camera
// sits MEETING_DISTANCE units in front of the agent (along their facing
// vector) at MEETING_HEIGHT, looking at the agent's chest at MEETING_TARGET_HEIGHT.
// These values reproduce the old hardcoded CEO meeting framing within ~0.1 units.
export const MEETING_DISTANCE = 4;
export const MEETING_HEIGHT = 2.2;
export const MEETING_TARGET_HEIGHT = 1.6;

// Camera follow params during the room-tour cinematic — closer + lower
// than the onboarding follow shot so the user feels like they're walking
// ~1 meter behind Jia (over-the-shoulder POV). Onboarding keeps its own
// FOLLOW_BACK / FOLLOW_HEIGHT (further back, more cinematic).
export const TOUR_FOLLOW_BACK = 1.5;
export const TOUR_FOLLOW_HEIGHT = 1.7;
// Per-frame camera position lerp during tour-follow. Onboarding's
// `LERP_FOLLOW = 0.06` is cinematic-slow (camera floats behind Jia);
// tour wants snappier tracking so micro-body-rotations don't feel
// like the camera is dragging behind.
export const TOUR_LERP_FOLLOW = 0.15;

// Pre-tour intro shot — camera sits in front of Jia (in the direction
// she's facing) at eye level so the user feels face-to-face with her
// while she delivers the welcome line. Distance + height tuned so her
// head + torso fill the frame without clipping the spawn-room ceiling.
export const TOUR_INTRO_DISTANCE = 2.6;
export const TOUR_INTRO_HEIGHT = 1.55;
export const TOUR_INTRO_LOOK_HEIGHT = 1.55;
export const LERP_TOUR_INTRO = 0.05;

// Pre-tour intro narration. Plays once, before Jia starts walking.
// Friendly self-introduction + early-demo disclaimer so first-time
// visitors know what they're looking at.
export const INTRO_DIALOG =
  "Hey, I'm Jia! Welcome to OCCA. This is the AI workforce that lives in here. We're still building it, so this is just an early peek. Real desks, real meetings, real characters. Come on, I'll show you around.";

export const LERP_ONBOARDING = 0.03;
export const LERP_ZOOM_OUT = 0.035;
export const LERP_FOLLOW = 0.06;
export const LERP_MEETING = 0.06;
export const FOLLOW_BACK = 5;
export const FOLLOW_HEIGHT = 2.5;

// Floor offset for the workstation-focus halo (the ring shown when the
// dev tool focuses a specific desk). Sits a hair above the floor to avoid
// z-fighting. Status haloes under agents were removed.
export const HALO_FLOOR_OFFSET = 0.02;

// "Room Tour" path — Jia walks these waypoints when the user triggers
// the tour from the Settings window. After reaching the last waypoint
// she reverses direction and walks back to GUIDE_POSITION (round-trip),
// then disappears. Each waypoint also carries `rotationY` so that
// "stand still and look around" pauses get replayed verbatim — the
// player rotates Jia to match before stepping to the next position.
//
// Captured via the dev "Record" tab. Re-record + paste here to update.

export const ROOM_TOUR_WAYPOINTS: readonly Waypoint[] = [
  // { position: new THREE.Vector3(-11.00, 0, 20.00), rotationY: 0.000, t: 0 },
  // { position: new THREE.Vector3(-11.00, 0, 20.00), rotationY: 0.000, t: 0 },
  // { position: new THREE.Vector3(-11.00, 0, 20.00), rotationY: 0.000, t: 510 },
  // { position: new THREE.Vector3(-11.00, 0, 20.00), rotationY: 0.000, t: 1025 },
  // { position: new THREE.Vector3(-11.00, 0, 20.00), rotationY: 0.000, t: 1542 },
  // { position: new THREE.Vector3(-11.00, 0, 20.00), rotationY: 0.000, t: 2059 },
  // { position: new THREE.Vector3(-11.00, 0, 20.00), rotationY: 0.000, t: 2559 },
  // { position: new THREE.Vector3(-10.96, 0, 20.63), rotationY: 0.294, t: 3142 },
  // { position: new THREE.Vector3(-10.57, 0, 21.1), rotationY: 1.064, t: 3492 },
  // { position: new THREE.Vector3(-9.95, 0, 21.16), rotationY: 1.834, t: 3842 },
  // { position: new THREE.Vector3(-9.47, 0, 20.78), rotationY: 2.565, t: 4191 },
  // { position: new THREE.Vector3(-9.14, 0, 20.28), rotationY: 2.565, t: 4526 },
  // { position: new THREE.Vector3(-8.96, 0, 19.69), rotationY: 3.188, t: 4875 },
  // { position: new THREE.Vector3(-9.09, 0, 19.08), rotationY: 3.37, t: 5225 },
  // { position: new THREE.Vector3(-9.23, 0, 18.46), rotationY: 3.37, t: 5575 },
  // { position: new THREE.Vector3(-9.37, 0, 17.85), rotationY: 3.37, t: 5926 },
  // { position: new THREE.Vector3(-9.51, 0, 17.26), rotationY: 3.37, t: 6259 },
  { position: new THREE.Vector3(-9.56, 0, 16.64), rotationY: 2.927, t: 6609 },
  { position: new THREE.Vector3(-9.31, 0, 16.07), rotationY: 2.708, t: 6959 },
  { position: new THREE.Vector3(-9.13, 0, 15.47), rotationY: 3.0, t: 7309 },
  { position: new THREE.Vector3(-9.04, 0, 14.88), rotationY: 3.0, t: 7642 },
  { position: new THREE.Vector3(-9.04, 0, 14.82), rotationY: 3.0, t: 8159 },
  { position: new THREE.Vector3(-9.04, 0, 14.82), rotationY: 3.0, t: 8676 },
  { position: new THREE.Vector3(-8.95, 0, 14.22), rotationY: 3.0, t: 9292 },
  { position: new THREE.Vector3(-8.8, 0, 13.61), rotationY: 2.631, t: 9642 },
  { position: new THREE.Vector3(-8.36, 0, 13.18), rotationY: 2.267, t: 9992 },
  { position: new THREE.Vector3(-7.89, 0, 12.76), rotationY: 2.487, t: 10342 },
  { position: new THREE.Vector3(-7.58, 0, 12.21), rotationY: 2.632, t: 10692 },
  { position: new THREE.Vector3(-7.35, 0, 11.63), rotationY: 3.072, t: 11042 },
  { position: new THREE.Vector3(-7.3, 0, 11.0), rotationY: 3.072, t: 11392 },
  { position: new THREE.Vector3(-7.26, 0, 10.4), rotationY: 3.072, t: 11726 },
  { position: new THREE.Vector3(-7.22, 0, 9.8), rotationY: 3.072, t: 12059 },
  { position: new THREE.Vector3(-7.18, 0, 9.18), rotationY: 3.072, t: 12408 },
  { position: new THREE.Vector3(-7.14, 0, 8.58), rotationY: 3.072, t: 12742 },
  { position: new THREE.Vector3(-7.3, 0, 7.98), rotationY: 3.623, t: 13092 },
  { position: new THREE.Vector3(-7.59, 0, 7.42), rotationY: 3.623, t: 13442 },
  { position: new THREE.Vector3(-7.99, 0, 6.94), rotationY: 3.987, t: 13792 },
  { position: new THREE.Vector3(-8.43, 0, 6.54), rotationY: 3.987, t: 14126 },
  { position: new THREE.Vector3(-8.96, 0, 6.21), rotationY: 4.39, t: 14476 },
  { position: new THREE.Vector3(-9.56, 0, 6.02), rotationY: 4.39, t: 14826 },
  { position: new THREE.Vector3(-10.16, 0, 5.82), rotationY: 4.39, t: 15176 },
  { position: new THREE.Vector3(-10.76, 0, 5.62), rotationY: 4.39, t: 15526 },
  { position: new THREE.Vector3(-11.35, 0, 5.42), rotationY: 4.39, t: 15876 },
  { position: new THREE.Vector3(-11.92, 0, 5.23), rotationY: 4.39, t: 16209 },
  { position: new THREE.Vector3(-12.52, 0, 5.03), rotationY: 4.39, t: 16559 },
  { position: new THREE.Vector3(-13.12, 0, 4.83), rotationY: 4.39, t: 16909 },
  { position: new THREE.Vector3(-13.69, 0, 4.64), rotationY: 4.39, t: 17242 },
  { position: new THREE.Vector3(-14.28, 0, 4.44), rotationY: 4.39, t: 17591 },
  { position: new THREE.Vector3(-14.85, 0, 4.25), rotationY: 4.39, t: 17926 },
  { position: new THREE.Vector3(-15.45, 0, 4.05), rotationY: 4.39, t: 18276 },
  { position: new THREE.Vector3(-15.99, 0, 3.87), rotationY: 4.39, t: 18609 },
  {
    position: new THREE.Vector3(-15.99, 0, 3.87),
    rotationY: 4.39,
    t: 19035,
    dialog:
      "Break room. Snacks, a pool table, holiday lights still up. This is where agents chill between tasks.",
  },
  { position: new THREE.Vector3(-15.99, 0, 3.87), rotationY: 4.39, t: 19542 },
  { position: new THREE.Vector3(-15.99, 0, 3.87), rotationY: 4.39, t: 20059 },
  { position: new THREE.Vector3(-15.99, 0, 3.87), rotationY: 4.39, t: 20559 },
  { position: new THREE.Vector3(-15.99, 0, 3.87), rotationY: 4.39, t: 21076 },
  { position: new THREE.Vector3(-15.99, 0, 3.87), rotationY: 4.39, t: 21593 },
  { position: new THREE.Vector3(-16.59, 0, 3.67), rotationY: 4.39, t: 22192 },
  { position: new THREE.Vector3(-17.16, 0, 3.42), rotationY: 4.17, t: 22542 },
  { position: new THREE.Vector3(-17.75, 0, 3.2), rotationY: 4.685, t: 22892 },
  { position: new THREE.Vector3(-18.32, 0, 3.43), rotationY: 5.456, t: 23242 },
  { position: new THREE.Vector3(-18.57, 0, 3.99), rotationY: 6.225, t: 23592 },
  { position: new THREE.Vector3(-18.58, 0, 4.52), rotationY: 6.262, t: 23908 },
  { position: new THREE.Vector3(-18.58, 0, 4.52), rotationY: 6.592, t: 24459 },
  { position: new THREE.Vector3(-18.58, 0, 4.52), rotationY: 6.922, t: 24609 },
  { position: new THREE.Vector3(-18.58, 0, 4.52), rotationY: 7.251, t: 24759 },
  { position: new THREE.Vector3(-18.08, 0, 4.85), rotationY: 7.434, t: 25560 },
  { position: new THREE.Vector3(-17.46, 0, 4.88), rotationY: 7.991, t: 25909 },
  { position: new THREE.Vector3(-16.86, 0, 4.8), rotationY: 7.991, t: 26242 },
  { position: new THREE.Vector3(-16.24, 0, 4.71), rotationY: 7.991, t: 26592 },
  { position: new THREE.Vector3(-15.62, 0, 4.61), rotationY: 8.21, t: 26942 },
  { position: new THREE.Vector3(-15.03, 0, 4.39), rotationY: 8.21, t: 27292 },
  { position: new THREE.Vector3(-14.47, 0, 4.18), rotationY: 8.21, t: 27626 },
  { position: new THREE.Vector3(-13.92, 0, 3.88), rotationY: 8.649, t: 27976 },
  { position: new THREE.Vector3(-13.74, 0, 3.69), rotationY: 8.684, t: 28142 },
  { position: new THREE.Vector3(-13.74, 0, 3.69), rotationY: 8.684, t: 28642 },
  { position: new THREE.Vector3(-13.35, 0, 3.23), rotationY: 8.905, t: 29010 },
  { position: new THREE.Vector3(-13.28, 0, 2.62), rotationY: 9.672, t: 29358 },
  { position: new THREE.Vector3(-13.43, 0, 2.01), rotationY: 9.672, t: 29709 },
  { position: new THREE.Vector3(-13.59, 0, 1.4), rotationY: 9.672, t: 30058 },
  { position: new THREE.Vector3(-13.7, 0, 0.81), rotationY: 9.563, t: 30392 },
  { position: new THREE.Vector3(-13.78, 0, 0.18), rotationY: 9.563, t: 30742 },
  { position: new THREE.Vector3(-13.94, 0, -0.42), rotationY: 9.783, t: 31091 },
  { position: new THREE.Vector3(-14.15, 0, -0.99), rotationY: 9.783, t: 31426 },
  { position: new THREE.Vector3(-14.37, 0, -1.58), rotationY: 9.783, t: 31777 },
  { position: new THREE.Vector3(-14.56, 0, -2.08), rotationY: 9.783, t: 32093 },
  {
    position: new THREE.Vector3(-14.56, 0, -2.08),
    rotationY: 9.783,
    t: 32348,
    dialog:
      "This is editorial. Writers, editors, fact-checkers. Raw research goes in, finished stories come out.",
  },
  { position: new THREE.Vector3(-14.56, 0, -2.08), rotationY: 9.783, t: 32858 },
  { position: new THREE.Vector3(-14.56, 0, -2.08), rotationY: 9.783, t: 33358 },
  { position: new THREE.Vector3(-14.56, 0, -2.08), rotationY: 9.783, t: 33859 },
  { position: new THREE.Vector3(-14.56, 0, -2.08), rotationY: 9.783, t: 34359 },
  { position: new THREE.Vector3(-14.56, 0, -2.08), rotationY: 9.783, t: 34859 },
  { position: new THREE.Vector3(-14.56, 0, -2.08), rotationY: 9.783, t: 35376 },
  { position: new THREE.Vector3(-14.78, 0, -2.64), rotationY: 9.929, t: 35942 },
  { position: new THREE.Vector3(-15.21, 0, -3.1), rotationY: 10.223, t: 36292 },
  { position: new THREE.Vector3(-15.69, 0, -3.5), rotationY: 10.553, t: 36642 },
  { position: new THREE.Vector3(-16.3, 0, -3.53), rotationY: 11.249, t: 36992 },
  { position: new THREE.Vector3(-16.8, 0, -3.4), rotationY: 11.249, t: 37292 },
  { position: new THREE.Vector3(-16.8, 0, -3.4), rotationY: 11.249, t: 37809 },
  {
    position: new THREE.Vector3(-17.37, 0, -3.23),
    rotationY: 11.469,
    t: 38459,
  },
  {
    position: new THREE.Vector3(-17.76, 0, -2.76),
    rotationY: 12.239,
    t: 38809,
  },
  {
    position: new THREE.Vector3(-17.79, 0, -2.13),
    rotationY: 12.606,
    t: 39159,
  },
  {
    position: new THREE.Vector3(-17.79, 0, -2.07),
    rotationY: 12.606,
    t: 39659,
  },
  {
    position: new THREE.Vector3(-17.79, 0, -2.07),
    rotationY: 12.936,
    t: 39909,
  },
  {
    position: new THREE.Vector3(-17.79, 0, -2.07),
    rotationY: 13.266,
    t: 40059,
  },
  {
    position: new THREE.Vector3(-17.79, 0, -2.07),
    rotationY: 13.339,
    t: 40575,
  },
  { position: new THREE.Vector3(-17.3, 0, -1.68), rotationY: 13.743, t: 41009 },
  {
    position: new THREE.Vector3(-16.69, 0, -1.68),
    rotationY: 14.511,
    t: 41358,
  },
  {
    position: new THREE.Vector3(-16.19, 0, -2.06),
    rotationY: 14.733,
    t: 41709,
  },
  {
    position: new THREE.Vector3(-15.59, 0, -2.25),
    rotationY: 14.368,
    t: 42058,
  },
  { position: new THREE.Vector3(-14.97, 0, -2.3), rotationY: 13.89, t: 42409 },
  { position: new THREE.Vector3(-14.47, 0, -1.94), rotationY: 13.34, t: 42759 },
  {
    position: new THREE.Vector3(-14.03, 0, -1.49),
    rotationY: 13.265,
    t: 43109,
  },
  { position: new THREE.Vector3(-13.83, 0, -0.9), rotationY: 12.678, t: 43458 },
  {
    position: new THREE.Vector3(-13.77, 0, -0.31),
    rotationY: 12.678,
    t: 43792,
  },
  { position: new THREE.Vector3(-13.7, 0, 0.29), rotationY: 12.678, t: 44126 },
  { position: new THREE.Vector3(-13.44, 0, 0.86), rotationY: 13.118, t: 44475 },
  { position: new THREE.Vector3(-13.03, 0, 1.33), rotationY: 13.599, t: 44828 },
  { position: new THREE.Vector3(-12.47, 0, 1.61), rotationY: 13.668, t: 45175 },
  { position: new THREE.Vector3(-11.89, 0, 1.76), rotationY: 13.926, t: 45509 },
  { position: new THREE.Vector3(-11.27, 0, 1.89), rotationY: 13.926, t: 45859 },
  { position: new THREE.Vector3(-10.69, 0, 2.02), rotationY: 13.926, t: 46192 },
  { position: new THREE.Vector3(-10.07, 0, 2.16), rotationY: 13.78, t: 46542 },
  { position: new THREE.Vector3(-9.53, 0, 2.48), rotationY: 13.598, t: 46892 },
  { position: new THREE.Vector3(-8.96, 0, 2.74), rotationY: 13.964, t: 47242 },
  { position: new THREE.Vector3(-8.36, 0, 2.62), rotationY: 14.514, t: 47592 },
  { position: new THREE.Vector3(-7.77, 0, 2.39), rotationY: 14.514, t: 47941 },
  { position: new THREE.Vector3(-7.21, 0, 2.17), rotationY: 14.514, t: 48276 },
  { position: new THREE.Vector3(-6.79, 0, 2.01), rotationY: 14.514, t: 48542 },
  { position: new THREE.Vector3(-6.79, 0, 2.01), rotationY: 14.844, t: 49059 },
  { position: new THREE.Vector3(-6.79, 0, 2.01), rotationY: 15.174, t: 49209 },
  { position: new THREE.Vector3(-6.79, 0, 2.01), rotationY: 15.174, t: 49726 },
  { position: new THREE.Vector3(-6.79, 0, 2.01), rotationY: 15.283, t: 50226 },
  { position: new THREE.Vector3(-6.53, 0, 1.43), rotationY: 15.283, t: 50909 },
  { position: new THREE.Vector3(-6.47, 0, 0.82), rotationY: 15.869, t: 51259 },
  { position: new THREE.Vector3(-6.47, 0, 0.2), rotationY: 15.393, t: 51612 },
  { position: new THREE.Vector3(-6.25, 0, -0.36), rotationY: 15.319, t: 51942 },
  { position: new THREE.Vector3(-6.17, 0, -0.97), rotationY: 15.759, t: 52293 },
  { position: new THREE.Vector3(-6.2, 0, -1.6), rotationY: 15.759, t: 52641 },
  { position: new THREE.Vector3(-6.37, 0, -2.2), rotationY: 16.201, t: 52992 },
  { position: new THREE.Vector3(-6.62, 0, -2.68), rotationY: 16.201, t: 53309 },
  { position: new THREE.Vector3(-6.62, 0, -2.68), rotationY: 16.201, t: 53826 },
  { position: new THREE.Vector3(-7.0, 0, -3.17), rotationY: 16.678, t: 54643 },
  { position: new THREE.Vector3(-7.6, 0, -3.31), rotationY: 17.264, t: 54993 },
  { position: new THREE.Vector3(-8.08, 0, -3.32), rotationY: 17.264, t: 55278 },
  { position: new THREE.Vector3(-8.08, 0, -3.32), rotationY: 17.264, t: 55793 },
  { position: new THREE.Vector3(-8.08, 0, -3.32), rotationY: 17.264, t: 56309 },
  { position: new THREE.Vector3(-8.08, 0, -3.32), rotationY: 17.594, t: 56809 },
  { position: new THREE.Vector3(-8.08, 0, -3.32), rotationY: 17.924, t: 56959 },
  { position: new THREE.Vector3(-8.08, 0, -3.32), rotationY: 18.254, t: 57109 },
  { position: new THREE.Vector3(-8.08, 0, -3.32), rotationY: 18.584, t: 57259 },
  { position: new THREE.Vector3(-8.08, 0, -3.32), rotationY: 18.621, t: 57759 },
  { position: new THREE.Vector3(-8.18, 0, -2.7), rotationY: 18.951, t: 58109 },
  { position: new THREE.Vector3(-7.9, 0, -2.14), rotationY: 19.464, t: 58459 },
  { position: new THREE.Vector3(-7.54, 0, -1.62), rotationY: 19.464, t: 58809 },
  { position: new THREE.Vector3(-7.18, 0, -1.11), rotationY: 19.464, t: 59159 },
  { position: new THREE.Vector3(-6.81, 0, -0.59), rotationY: 19.464, t: 59509 },
  { position: new THREE.Vector3(-6.45, 0, -0.08), rotationY: 19.464, t: 59859 },
  { position: new THREE.Vector3(-6.09, 0, 0.44), rotationY: 19.464, t: 60209 },
  { position: new THREE.Vector3(-5.74, 0, 0.93), rotationY: 19.464, t: 60543 },
  { position: new THREE.Vector3(-5.27, 0, 1.34), rotationY: 19.757, t: 60891 },
  { position: new THREE.Vector3(-4.79, 0, 1.71), rotationY: 19.757, t: 61226 },
  { position: new THREE.Vector3(-4.22, 0, 1.96), rotationY: 20.087, t: 61576 },
  { position: new THREE.Vector3(-3.63, 0, 2.17), rotationY: 20.087, t: 61926 },
  { position: new THREE.Vector3(-3.06, 0, 2.37), rotationY: 20.087, t: 62259 },
  { position: new THREE.Vector3(-2.54, 0, 2.71), rotationY: 19.611, t: 62609 },
  { position: new THREE.Vector3(-2.52, 0, 2.73), rotationY: 19.611, t: 63109 },
  { position: new THREE.Vector3(-2.52, 0, 2.73), rotationY: 19.611, t: 63626 },
  { position: new THREE.Vector3(-2.52, 0, 2.73), rotationY: 19.941, t: 63843 },
  { position: new THREE.Vector3(-2.52, 0, 2.73), rotationY: 20.271, t: 63993 },
  { position: new THREE.Vector3(-2.52, 0, 2.73), rotationY: 20.601, t: 64142 },
  { position: new THREE.Vector3(-2.52, 0, 2.73), rotationY: 20.931, t: 64292 },
  { position: new THREE.Vector3(-2.52, 0, 2.73), rotationY: 21.261, t: 64443 },
  { position: new THREE.Vector3(-2.52, 0, 2.73), rotationY: 21.261, t: 64959 },
  { position: new THREE.Vector3(-2.52, 0, 2.73), rotationY: 21.261, t: 65476 },
  { position: new THREE.Vector3(-2.34, 0, 2.53), rotationY: 21.334, t: 65876 },
  { position: new THREE.Vector3(-2.19, 0, 1.93), rotationY: 22.104, t: 66226 },
  { position: new THREE.Vector3(-2.36, 0, 1.33), rotationY: 22.287, t: 66576 },
  { position: new THREE.Vector3(-2.53, 0, 0.72), rotationY: 22.141, t: 66926 },
  { position: new THREE.Vector3(-2.47, 0, 0.1), rotationY: 21.847, t: 67276 },
  { position: new THREE.Vector3(-2.39, 0, -0.5), rotationY: 21.847, t: 67609 },
  { position: new THREE.Vector3(-2.18, 0, -1.08), rotationY: 21.554, t: 67959 },
  { position: new THREE.Vector3(-1.91, 0, -1.66), rotationY: 21.554, t: 68309 },
  { position: new THREE.Vector3(-1.48, 0, -2.1), rotationY: 21.041, t: 68659 },
  { position: new THREE.Vector3(-1.31, 0, -2.22), rotationY: 21.041, t: 68795 },
  { position: new THREE.Vector3(-1.31, 0, -2.22), rotationY: 21.041, t: 69309 },
  { position: new THREE.Vector3(-0.8, 0, -2.59), rotationY: 21.004, t: 69892 },
  { position: new THREE.Vector3(-0.19, 0, -2.7), rotationY: 20.234, t: 70243 },
  { position: new THREE.Vector3(0.37, 0, -2.41), rotationY: 19.866, t: 70593 },
  { position: new THREE.Vector3(0.89, 0, -2.07), rotationY: 19.72, t: 70942 },
  { position: new THREE.Vector3(1.18, 0, -1.52), rotationY: 19.06, t: 71293 },
  { position: new THREE.Vector3(1.31, 0, -0.91), rotationY: 19.06, t: 71643 },
  { position: new THREE.Vector3(1.34, 0, -0.28), rotationY: 18.767, t: 71993 },
  { position: new THREE.Vector3(1.34, 0, 0.34), rotationY: 19.06, t: 72343 },
  { position: new THREE.Vector3(1.48, 0, 0.95), rotationY: 19.245, t: 72693 },
  { position: new THREE.Vector3(1.92, 0, 1.38), rotationY: 20.015, t: 73043 },
  { position: new THREE.Vector3(2.54, 0, 1.53), rotationY: 20.199, t: 73393 },
  { position: new THREE.Vector3(3.15, 0, 1.67), rotationY: 20.199, t: 73743 },
  { position: new THREE.Vector3(3.74, 0, 1.8), rotationY: 20.199, t: 74076 },
  { position: new THREE.Vector3(4.36, 0, 1.78), rotationY: 20.565, t: 74426 },
  { position: new THREE.Vector3(4.98, 0, 1.69), rotationY: 20.565, t: 74776 },
  { position: new THREE.Vector3(5.59, 0, 1.79), rotationY: 19.905, t: 75127 },
  { position: new THREE.Vector3(6.04, 0, 2.23), rotationY: 19.575, t: 75476 },
  { position: new THREE.Vector3(6.45, 0, 2.7), rotationY: 19.575, t: 75826 },
  { position: new THREE.Vector3(6.93, 0, 3.1), rotationY: 19.884, t: 76176 },
  { position: new THREE.Vector3(7.45, 0, 3.41), rotationY: 19.884, t: 76509 },
  { position: new THREE.Vector3(8.0, 0, 3.71), rotationY: 20.106, t: 76860 },
  { position: new THREE.Vector3(8.57, 0, 3.9), rotationY: 20.106, t: 77193 },
  { position: new THREE.Vector3(9.18, 0, 4.02), rotationY: 20.509, t: 77543 },
  { position: new THREE.Vector3(9.8, 0, 3.92), rotationY: 20.581, t: 77893 },
  { position: new THREE.Vector3(10.4, 0, 3.74), rotationY: 20.839, t: 78243 },
  { position: new THREE.Vector3(10.9, 0, 3.37), rotationY: 21.39, t: 78593 },
  { position: new THREE.Vector3(11.26, 0, 2.85), rotationY: 21.39, t: 78943 },
  { position: new THREE.Vector3(11.61, 0, 2.33), rotationY: 21.536, t: 79293 },
  { position: new THREE.Vector3(11.75, 0, 1.84), rotationY: 21.719, t: 79593 },
  { position: new THREE.Vector3(11.91, 0, 1.26), rotationY: 21.719, t: 80026 },
  { position: new THREE.Vector3(12.2, 0, 0.71), rotationY: 21.17, t: 80376 },
  { position: new THREE.Vector3(12.59, 0, 0.38), rotationY: 21.134, t: 80676 },
  {
    position: new THREE.Vector3(12.59, 0, 0.38),
    rotationY: 21.134,
    t: 81098,
    dialog:
      "Content studio. Half production set, half lounge. Beanbags, an arcade machine, and a green screen for whenever someone needs to shoot.",
  },
  { position: new THREE.Vector3(12.59, 0, 0.38), rotationY: 21.134, t: 81609 },
  { position: new THREE.Vector3(12.59, 0, 0.38), rotationY: 21.134, t: 82126 },
  { position: new THREE.Vector3(12.59, 0, 0.38), rotationY: 21.463, t: 82759 },
  { position: new THREE.Vector3(12.59, 0, 0.38), rotationY: 21.61, t: 83260 },
  { position: new THREE.Vector3(12.59, 0, 0.38), rotationY: 21.61, t: 83776 },
  { position: new THREE.Vector3(12.59, 0, 0.38), rotationY: 21.61, t: 84276 },
  { position: new THREE.Vector3(12.59, 0, 0.38), rotationY: 21.61, t: 84793 },
  { position: new THREE.Vector3(12.59, 0, 0.38), rotationY: 21.28, t: 85159 },
  { position: new THREE.Vector3(13.01, 0, -0.08), rotationY: 21.243, t: 85743 },
  { position: new THREE.Vector3(13.54, 0, -0.41), rotationY: 20.731, t: 86093 },
  { position: new THREE.Vector3(13.96, 0, -0.55), rotationY: 20.731, t: 86359 },
  { position: new THREE.Vector3(13.96, 0, -0.55), rotationY: 20.731, t: 86859 },
  { position: new THREE.Vector3(13.96, 0, -0.55), rotationY: 20.401, t: 87309 },
  { position: new THREE.Vector3(13.96, 0, -0.55), rotationY: 20.071, t: 87459 },
  { position: new THREE.Vector3(13.96, 0, -0.55), rotationY: 20.071, t: 87959 },
  { position: new THREE.Vector3(13.96, 0, -0.55), rotationY: 20.401, t: 88576 },
  { position: new THREE.Vector3(13.96, 0, -0.55), rotationY: 20.731, t: 88726 },
  { position: new THREE.Vector3(13.96, 0, -0.55), rotationY: 21.061, t: 88876 },
  { position: new THREE.Vector3(13.96, 0, -0.55), rotationY: 21.391, t: 89027 },
  { position: new THREE.Vector3(13.96, 0, -0.55), rotationY: 21.72, t: 89176 },
  { position: new THREE.Vector3(13.96, 0, -0.55), rotationY: 21.904, t: 89676 },
  { position: new THREE.Vector3(13.97, 0, -1.18), rotationY: 22.234, t: 90159 },
  { position: new THREE.Vector3(13.68, 0, -1.74), rotationY: 22.381, t: 90509 },
  { position: new THREE.Vector3(13.61, 0, -2.36), rotationY: 22.052, t: 90860 },
  { position: new THREE.Vector3(13.57, 0, -2.96), rotationY: 22.015, t: 91193 },
  { position: new THREE.Vector3(13.8, 0, -3.53), rotationY: 21.245, t: 91543 },
  { position: new THREE.Vector3(14.22, 0, -4.0), rotationY: 21.392, t: 91893 },
  { position: new THREE.Vector3(14.45, 0, -4.58), rotationY: 21.648, t: 92243 },
  { position: new THREE.Vector3(14.52, 0, -5.21), rotationY: 21.978, t: 92593 },
  { position: new THREE.Vector3(14.52, 0, -5.83), rotationY: 22.089, t: 92943 },
  { position: new THREE.Vector3(14.26, 0, -6.4), rotationY: 22.528, t: 93293 },
  { position: new THREE.Vector3(13.95, 0, -6.92), rotationY: 22.677, t: 93643 },
  { position: new THREE.Vector3(13.95, 0, -6.92), rotationY: 22.751, t: 94159 },
  { position: new THREE.Vector3(13.95, 0, -6.92), rotationY: 23.081, t: 94793 },
  { position: new THREE.Vector3(13.95, 0, -6.92), rotationY: 23.411, t: 94943 },
  { position: new THREE.Vector3(13.95, 0, -6.92), rotationY: 23.74, t: 95092 },
  { position: new THREE.Vector3(13.95, 0, -6.92), rotationY: 24.071, t: 95243 },
  { position: new THREE.Vector3(13.95, 0, -6.92), rotationY: 24.401, t: 95393 },
  { position: new THREE.Vector3(13.95, 0, -6.92), rotationY: 24.401, t: 95893 },
  { position: new THREE.Vector3(13.95, 0, -6.92), rotationY: 24.401, t: 96409 },
  { position: new THREE.Vector3(13.54, 0, -6.44), rotationY: 24.511, t: 96776 },
  { position: new THREE.Vector3(13.37, 0, -5.84), rotationY: 25.024, t: 97126 },
  { position: new THREE.Vector3(13.3, 0, -5.22), rotationY: 25.061, t: 97476 },
  { position: new THREE.Vector3(13.34, 0, -4.59), rotationY: 25.208, t: 97826 },
  { position: new THREE.Vector3(13.24, 0, -3.97), rotationY: 24.914, t: 98176 },
  { position: new THREE.Vector3(13.1, 0, -3.35), rotationY: 24.914, t: 98526 },
  { position: new THREE.Vector3(12.96, 0, -2.74), rotationY: 24.914, t: 98876 },
  { position: new THREE.Vector3(12.71, 0, -2.16), rotationY: 24.697, t: 99226 },
  { position: new THREE.Vector3(12.46, 0, -1.62), rotationY: 24.697, t: 99560 },
  { position: new THREE.Vector3(12.21, 0, -1.07), rotationY: 24.697, t: 99893 },
  { position: new THREE.Vector3(11.99, 0, -0.48), rotationY: 24.88, t: 100243 },
  { position: new THREE.Vector3(11.83, 0, 0.12), rotationY: 24.88, t: 100593 },
  { position: new THREE.Vector3(11.68, 0, 0.73), rotationY: 24.88, t: 100943 },
  { position: new THREE.Vector3(11.53, 0, 1.32), rotationY: 24.88, t: 101276 },
  { position: new THREE.Vector3(11.39, 0, 1.93), rotationY: 25.1, t: 101626 },
  { position: new THREE.Vector3(11.48, 0, 2.55), rotationY: 25.32, t: 101976 },
  { position: new THREE.Vector3(11.76, 0, 3.11), rotationY: 25.687, t: 102326 },
  { position: new THREE.Vector3(12.18, 0, 3.57), rotationY: 26.2, t: 102676 },
  { position: new THREE.Vector3(12.79, 0, 3.69), rotationY: 26.604, t: 103026 },
  { position: new THREE.Vector3(13.42, 0, 3.71), rotationY: 26.751, t: 103376 },
  { position: new THREE.Vector3(14.05, 0, 3.69), rotationY: 26.606, t: 103725 },
  { position: new THREE.Vector3(14.64, 0, 3.83), rotationY: 26.457, t: 104060 },
  { position: new THREE.Vector3(15.25, 0, 3.98), rotationY: 26.42, t: 104410 },
  { position: new THREE.Vector3(15.8, 0, 4.27), rotationY: 26.2, t: 104759 },
  { position: new THREE.Vector3(16.01, 0, 4.39), rotationY: 26.2, t: 104909 },
  { position: new THREE.Vector3(16.01, 0, 4.39), rotationY: 25.87, t: 105409 },
  { position: new THREE.Vector3(16.01, 0, 4.39), rotationY: 25.614, t: 105909 },
  { position: new THREE.Vector3(16.31, 0, 4.95), rotationY: 25.614, t: 106693 },
  { position: new THREE.Vector3(16.38, 0, 5.56), rotationY: 24.917, t: 107043 },
  { position: new THREE.Vector3(16.27, 0, 6.18), rotationY: 25.174, t: 107393 },
  { position: new THREE.Vector3(16.49, 0, 6.76), rotationY: 25.577, t: 107743 },
  { position: new THREE.Vector3(16.58, 0, 6.95), rotationY: 25.577, t: 107876 },
  {
    position: new THREE.Vector3(16.58, 0, 6.95),
    rotationY: 25.577,
    t: 108124,
    dialog:
      "Engineering and research. Engineers, analysts, smart contract auditors, tokenomics designers. Honestly, most of the real work happens at these desks.",
  },
  { position: new THREE.Vector3(16.58, 0, 6.95), rotationY: 25.577, t: 108626 },
  { position: new THREE.Vector3(16.58, 0, 6.95), rotationY: 25.577, t: 109126 },
  { position: new THREE.Vector3(16.58, 0, 6.95), rotationY: 25.577, t: 109626 },
  { position: new THREE.Vector3(16.58, 0, 6.95), rotationY: 25.577, t: 110126 },
  { position: new THREE.Vector3(16.58, 0, 6.95), rotationY: 25.577, t: 110643 },
  { position: new THREE.Vector3(16.58, 0, 6.95), rotationY: 25.248, t: 111243 },
  { position: new THREE.Vector3(16.58, 0, 6.95), rotationY: 25.175, t: 111743 },
  { position: new THREE.Vector3(16.58, 0, 6.95), rotationY: 25.175, t: 112243 },
  { position: new THREE.Vector3(16.58, 0, 6.95), rotationY: 25.505, t: 112760 },
  { position: new THREE.Vector3(16.58, 0, 6.95), rotationY: 25.688, t: 113275 },
  { position: new THREE.Vector3(16.58, 0, 6.95), rotationY: 25.688, t: 113776 },
  { position: new THREE.Vector3(16.89, 0, 7.46), rotationY: 25.615, t: 114210 },
  { position: new THREE.Vector3(16.98, 0, 8.08), rotationY: 25.138, t: 114558 },
  { position: new THREE.Vector3(16.98, 0, 8.68), rotationY: 25.1, t: 114894 },
  { position: new THREE.Vector3(16.81, 0, 9.29), rotationY: 24.806, t: 115243 },
  { position: new THREE.Vector3(16.61, 0, 9.88), rotationY: 24.806, t: 115593 },
  {
    position: new THREE.Vector3(16.61, 0, 10.51),
    rotationY: 25.246,
    t: 115943,
  },
  {
    position: new THREE.Vector3(16.67, 0, 11.11),
    rotationY: 25.246,
    t: 116278,
  },
  {
    position: new THREE.Vector3(16.74, 0, 11.73),
    rotationY: 25.246,
    t: 116626,
  },
  {
    position: new THREE.Vector3(16.82, 0, 12.35),
    rotationY: 25.246,
    t: 116976,
  },
  {
    position: new THREE.Vector3(16.88, 0, 12.98),
    rotationY: 25.173,
    t: 117326,
  },
  {
    position: new THREE.Vector3(16.68, 0, 13.56),
    rotationY: 24.586,
    t: 117677,
  },
  { position: new THREE.Vector3(16.4, 0, 14.03), rotationY: 24.586, t: 117993 },
  { position: new THREE.Vector3(16.4, 0, 14.03), rotationY: 24.257, t: 118343 },
  { position: new THREE.Vector3(16.4, 0, 14.03), rotationY: 23.926, t: 118493 },
  { position: new THREE.Vector3(16.4, 0, 14.03), rotationY: 23.89, t: 118993 },
  { position: new THREE.Vector3(16.4, 0, 14.03), rotationY: 23.56, t: 119409 },
  { position: new THREE.Vector3(16.4, 0, 14.03), rotationY: 23.23, t: 119559 },
  { position: new THREE.Vector3(16.4, 0, 14.03), rotationY: 22.9, t: 119710 },
  {
    position: new THREE.Vector3(15.95, 0, 13.59),
    rotationY: 22.606,
    t: 120259,
  },
  {
    position: new THREE.Vector3(15.82, 0, 12.99),
    rotationY: 21.836,
    t: 120610,
  },
  {
    position: new THREE.Vector3(16.08, 0, 12.41),
    rotationY: 21.506,
    t: 120960,
  },
  {
    position: new THREE.Vector3(16.19, 0, 11.81),
    rotationY: 22.166,
    t: 121310,
  },
  {
    position: new THREE.Vector3(16.08, 0, 11.31),
    rotationY: 22.203,
    t: 121610,
  },
  {
    position: new THREE.Vector3(16.08, 0, 11.31),
    rotationY: 22.533,
    t: 121976,
  },
  {
    position: new THREE.Vector3(16.08, 0, 11.31),
    rotationY: 22.827,
    t: 122493,
  },
  {
    position: new THREE.Vector3(16.08, 0, 11.31),
    rotationY: 22.827,
    t: 123010,
  },
  {
    position: new THREE.Vector3(16.08, 0, 11.31),
    rotationY: 22.497,
    t: 123376,
  },
  {
    position: new THREE.Vector3(16.08, 0, 11.31),
    rotationY: 22.165,
    t: 123527,
  },
  {
    position: new THREE.Vector3(16.16, 0, 10.69),
    rotationY: 21.544,
    t: 124226,
  },
  {
    position: new THREE.Vector3(16.49, 0, 10.19),
    rotationY: 21.397,
    t: 124560,
  },
  { position: new THREE.Vector3(16.82, 0, 9.66), rotationY: 21.653, t: 124910 },
  { position: new THREE.Vector3(16.89, 0, 9.03), rotationY: 21.91, t: 125260 },
  { position: new THREE.Vector3(16.94, 0, 8.4), rotationY: 21.91, t: 125610 },
  { position: new THREE.Vector3(16.99, 0, 7.78), rotationY: 21.91, t: 125959 },
  { position: new THREE.Vector3(17.0, 0, 7.66), rotationY: 21.91, t: 126043 },
  { position: new THREE.Vector3(17.0, 0, 7.66), rotationY: 22.24, t: 126326 },
  { position: new THREE.Vector3(17.0, 0, 7.66), rotationY: 22.57, t: 126476 },
  { position: new THREE.Vector3(17.0, 0, 7.66), rotationY: 22.644, t: 126976 },
  { position: new THREE.Vector3(17.0, 0, 7.66), rotationY: 22.974, t: 127326 },
  { position: new THREE.Vector3(17.0, 0, 7.66), rotationY: 23.302, t: 127475 },
  { position: new THREE.Vector3(17.0, 0, 7.66), rotationY: 23.634, t: 127626 },
  { position: new THREE.Vector3(17.0, 0, 7.66), rotationY: 23.78, t: 128143 },
  { position: new THREE.Vector3(17.0, 0, 7.66), rotationY: 24.11, t: 128793 },
  { position: new THREE.Vector3(17.0, 0, 7.66), rotationY: 24.441, t: 128943 },
  { position: new THREE.Vector3(17.0, 0, 7.66), rotationY: 24.771, t: 129093 },
  { position: new THREE.Vector3(17.0, 0, 7.66), rotationY: 25.101, t: 129243 },
  { position: new THREE.Vector3(17.0, 0, 7.66), rotationY: 25.43, t: 129393 },
  { position: new THREE.Vector3(17.0, 0, 7.66), rotationY: 25.761, t: 129543 },
  { position: new THREE.Vector3(17.0, 0, 7.66), rotationY: 26.09, t: 129693 },
  { position: new THREE.Vector3(17.0, 0, 7.66), rotationY: 26.127, t: 130210 },
  { position: new THREE.Vector3(17.58, 0, 7.89), rotationY: 26.64, t: 130860 },
  { position: new THREE.Vector3(18.16, 0, 7.69), rotationY: 27.411, t: 131210 },
  { position: new THREE.Vector3(18.67, 0, 7.33), rotationY: 27.19, t: 131560 },
  { position: new THREE.Vector3(19.23, 0, 7.05), rotationY: 27.005, t: 131910 },
  { position: new THREE.Vector3(19.85, 0, 7.07), rotationY: 26.528, t: 132260 },
  { position: new THREE.Vector3(20.47, 0, 7.18), rotationY: 26.528, t: 132610 },
  { position: new THREE.Vector3(21.09, 0, 7.29), rotationY: 26.528, t: 132959 },
  { position: new THREE.Vector3(21.68, 0, 7.4), rotationY: 26.528, t: 133293 },
  { position: new THREE.Vector3(22.3, 0, 7.5), rotationY: 26.601, t: 133643 },
  { position: new THREE.Vector3(22.93, 0, 7.41), rotationY: 26.895, t: 133993 },
  { position: new THREE.Vector3(23.53, 0, 7.54), rotationY: 26.125, t: 134343 },
  { position: new THREE.Vector3(23.87, 0, 8.06), rotationY: 25.355, t: 134693 },
  { position: new THREE.Vector3(23.92, 0, 8.68), rotationY: 25.208, t: 135043 },
  { position: new THREE.Vector3(23.92, 0, 9.31), rotationY: 24.952, t: 135393 },
  { position: new THREE.Vector3(23.87, 0, 9.93), rotationY: 25.355, t: 135743 },
  {
    position: new THREE.Vector3(24.02, 0, 10.51),
    rotationY: 25.318,
    t: 136076,
  },
  {
    position: new THREE.Vector3(24.02, 0, 11.14),
    rotationY: 25.098,
    t: 136426,
  },
  { position: new THREE.Vector3(24.0, 0, 11.74), rotationY: 25.098, t: 136760 },
  {
    position: new THREE.Vector3(23.98, 0, 12.37),
    rotationY: 25.098,
    t: 137110,
  },
  {
    position: new THREE.Vector3(23.91, 0, 12.99),
    rotationY: 24.768,
    t: 137460,
  },
  {
    position: new THREE.Vector3(23.58, 0, 13.52),
    rotationY: 24.402,
    t: 137810,
  },
  {
    position: new THREE.Vector3(23.44, 0, 13.68),
    rotationY: 24.402,
    t: 137944,
  },
  {
    position: new THREE.Vector3(23.44, 0, 13.68),
    rotationY: 24.071,
    t: 138360,
  },
  {
    position: new THREE.Vector3(23.44, 0, 13.68),
    rotationY: 23.741,
    t: 138511,
  },
  {
    position: new THREE.Vector3(23.44, 0, 13.68),
    rotationY: 23.411,
    t: 138660,
  },
  {
    position: new THREE.Vector3(23.44, 0, 13.68),
    rotationY: 23.338,
    t: 139160,
  },
  {
    position: new THREE.Vector3(23.44, 0, 13.68),
    rotationY: 23.008,
    t: 139760,
  },
  {
    position: new THREE.Vector3(23.44, 0, 13.68),
    rotationY: 23.008,
    t: 140264,
  },
  {
    position: new THREE.Vector3(23.44, 0, 13.68),
    rotationY: 23.008,
    t: 140776,
  },
  {
    position: new THREE.Vector3(23.44, 0, 13.68),
    rotationY: 22.677,
    t: 141193,
  },
  {
    position: new THREE.Vector3(23.44, 0, 13.68),
    rotationY: 22.348,
    t: 141343,
  },
  {
    position: new THREE.Vector3(23.44, 0, 13.68),
    rotationY: 22.018,
    t: 141493,
  },
  {
    position: new THREE.Vector3(23.44, 0, 13.68),
    rotationY: 21.688,
    t: 141643,
  },
  {
    position: new THREE.Vector3(23.44, 0, 13.68),
    rotationY: 21.358,
    t: 141793,
  },
  {
    position: new THREE.Vector3(23.44, 0, 13.68),
    rotationY: 21.287,
    t: 142310,
  },
  {
    position: new THREE.Vector3(23.83, 0, 13.22),
    rotationY: 21.325,
    t: 142728,
  },
  {
    position: new THREE.Vector3(24.05, 0, 12.64),
    rotationY: 21.727,
    t: 143077,
  },
  {
    position: new THREE.Vector3(24.21, 0, 12.03),
    rotationY: 21.727,
    t: 143426,
  },
  { position: new THREE.Vector3(24.27, 0, 11.41), rotationY: 22.02, t: 143776 },
  { position: new THREE.Vector3(24.25, 0, 10.81), rotationY: 22.02, t: 144110 },
  { position: new THREE.Vector3(24.23, 0, 10.18), rotationY: 22.02, t: 144460 },
  { position: new THREE.Vector3(24.21, 0, 9.58), rotationY: 22.02, t: 144793 },
  { position: new THREE.Vector3(24.2, 0, 8.95), rotationY: 22.02, t: 145143 },
  { position: new THREE.Vector3(24.18, 0, 8.35), rotationY: 22.02, t: 145477 },
  { position: new THREE.Vector3(23.96, 0, 7.76), rotationY: 22.46, t: 145826 },
  { position: new THREE.Vector3(23.64, 0, 7.23), rotationY: 22.79, t: 146176 },
  { position: new THREE.Vector3(23.07, 0, 6.97), rotationY: 23.267, t: 146526 },
  { position: new THREE.Vector3(22.49, 0, 6.73), rotationY: 22.974, t: 146877 },
  { position: new THREE.Vector3(21.97, 0, 6.38), rotationY: 22.974, t: 147226 },
  { position: new THREE.Vector3(21.4, 0, 6.12), rotationY: 23.227, t: 147576 },
  { position: new THREE.Vector3(20.9, 0, 5.76), rotationY: 22.567, t: 147926 },
  { position: new THREE.Vector3(20.8, 0, 5.15), rotationY: 21.797, t: 148276 },
  { position: new THREE.Vector3(20.91, 0, 4.56), rotationY: 21.797, t: 148610 },
  { position: new THREE.Vector3(20.95, 0, 4.39), rotationY: 21.797, t: 148726 },
  {
    position: new THREE.Vector3(20.95, 0, 4.39),
    rotationY: 21.797,
    t: 149190,
    dialog:
      "And finally, the boardroom. C-suite meets here, big calls get made here. That's the whole company. Thanks for coming along!",
  },
  { position: new THREE.Vector3(20.95, 0, 4.39), rotationY: 21.797, t: 149693 },
  { position: new THREE.Vector3(20.95, 0, 4.39), rotationY: 21.797, t: 150210 },
  { position: new THREE.Vector3(20.95, 0, 4.39), rotationY: 21.797, t: 150710 },
  { position: new THREE.Vector3(20.95, 0, 4.39), rotationY: 21.797, t: 151226 },
  // { position: new THREE.Vector3(20.95, 0, 4.39), rotationY: 22.017, t: 151743 },
  // { position: new THREE.Vector3(20.95, 0, 4.39), rotationY: 22.017, t: 152243 },
  // { position: new THREE.Vector3(20.95, 0, 4.39), rotationY: 22.017, t: 152743 },
  // { position: new THREE.Vector3(20.95, 0, 4.39), rotationY: 22.017, t: 153260 },
  // { position: new THREE.Vector3(20.95, 0, 4.39), rotationY: 21.687, t: 153643 },
  // { position: new THREE.Vector3(20.95, 0, 4.39), rotationY: 21.54, t: 154143 },
  // { position: new THREE.Vector3(20.95, 0, 4.39), rotationY: 21.54, t: 154643 },
  // { position: new THREE.Vector3(20.95, 0, 4.39), rotationY: 21.54, t: 155143 },
  // { position: new THREE.Vector3(21.02, 0, 4.22), rotationY: 21.54, t: 155343 },
  // { position: new THREE.Vector3(21.02, 0, 4.22), rotationY: 21.54, t: 155843 },
  // { position: new THREE.Vector3(21.32, 0, 3.67), rotationY: 21.32, t: 156293 },
  // { position: new THREE.Vector3(21.86, 0, 3.36), rotationY: 20.697, t: 156643 },
  // { position: new THREE.Vector3(22.46, 0, 3.19), rotationY: 20.697, t: 156993 },
  // { position: new THREE.Vector3(22.97, 0, 2.84), rotationY: 21.394, t: 157343 },
  // { position: new THREE.Vector3(23.21, 0, 2.26), rotationY: 21.614, t: 157693 },
  // { position: new THREE.Vector3(23.59, 0, 1.76), rotationY: 21.174, t: 158043 },
  // { position: new THREE.Vector3(23.61, 0, 1.74), rotationY: 21.174, t: 158543 },
  // { position: new THREE.Vector3(23.61, 0, 1.74), rotationY: 21.504, t: 159010 },
  // { position: new THREE.Vector3(23.61, 0, 1.74), rotationY: 21.834, t: 159160 },
  // { position: new THREE.Vector3(23.61, 0, 1.74), rotationY: 22.164, t: 159310 },
  // { position: new THREE.Vector3(23.61, 0, 1.74), rotationY: 22.495, t: 159460 },
  // { position: new THREE.Vector3(23.61, 0, 1.74), rotationY: 22.824, t: 159610 },
  // { position: new THREE.Vector3(23.61, 0, 1.74), rotationY: 23.154, t: 159760 },
  // { position: new THREE.Vector3(23.61, 0, 1.74), rotationY: 23.486, t: 159911 },
  // { position: new THREE.Vector3(23.61, 0, 1.74), rotationY: 23.814, t: 160060 },
  // { position: new THREE.Vector3(23.61, 0, 1.74), rotationY: 23.96, t: 160560 },
  // { position: new THREE.Vector3(23.61, 0, 1.74), rotationY: 24.29, t: 161160 },
  // { position: new THREE.Vector3(23.61, 0, 1.74), rotationY: 24.62, t: 161310 },
  // { position: new THREE.Vector3(23.32, 0, 2.3), rotationY: 24.657, t: 161943 },
  // { position: new THREE.Vector3(22.86, 0, 2.71), rotationY: 23.923, t: 162293 },
  // { position: new THREE.Vector3(22.25, 0, 2.69), rotationY: 23.3, t: 162643 },
  // { position: new THREE.Vector3(21.63, 0, 2.59), rotationY: 23.592, t: 162994 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.592, t: 163327 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.262, t: 163910 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 164410 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 164911 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 165426 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 165927 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 166427 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 166927 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 167443 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 167960, dialog: "TODO: dialog text here" },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 168460 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 168960 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 169476 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 169977 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 170494 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 171010 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 171512 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 172027 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 172527 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 173043 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 173546 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 174060 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 174577 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 175077 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 175587 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 176094 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 176610 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 177110 },
  // { position: new THREE.Vector3(21.03, 0, 2.61), rotationY: 23.005, t: 177611 },
];
