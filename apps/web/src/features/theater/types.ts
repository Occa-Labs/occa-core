export type WalkPhase = "walking" | "meeting" | null;
export type SceneBounds = [number, number, number, number]; // minX minZ maxX maxZ
export type CameraMode =
  | "onboarding"
  | "zoom-out"
  | "follow-guide"
  | "tour-intro"
  | "tour-follow"
  | "agent-focus"
  | "idle";

// Agent presence/status shown in scene badges. Agent-agnostic — decoupled
// from any runtime adapter. Adapter mapping happens upstream.
//
// Realtime integration point: AgentStatus is derived (in `utils.ts`) from
// AgentDTO fields delivered by the `useMe` query (currently 10s polling).
// When SSE / WS realtime updates land, they should flow through that hook
// (or a sibling `useAgentRuntimeStream`) updating TanStack Query cache —
// the theater feature consumes the resolved status and stays unaware of
// the transport. No realtime plumbing inside theater.
export type AgentStatus =
  | "provisioning"
  | "offline"
  | "connecting"
  | "idle"
  | "talking"
  | "working"
  | "meeting"
  | "cooldown"
  | "error";

// Subset of AgentDTO needed to derive a scene badge status. Decoupled from
// the shared schema so the theater feature stays agent-agnostic.
export interface AgentStatusSource {
  provisioningState: "pending" | "ready" | "failed";
  connectionState: "connected" | "disconnected" | "unknown";
  activityState: "idle" | "working" | "cooldown" | "error";
}

// What the parent feeds OfficeScene per agent. Page applies any UX overrides
// (e.g. CEO status="talking" during kickoff dialog) before passing.
export interface SceneAgent {
  id: string;
  role: string;
  name: string;
  status: AgentStatus;
  ready: boolean;
  // Server-assigned 3D office seat. NULL for legacy rows pre-migration —
  // theater falls back to a deterministic role-based pick.
  workstationId: string | null;
  // Hire timestamp (ISO). Drives stable sort for the model-claim algorithm
  // so older agents keep their model when newer ones are hired.
  createdAt: string;
  // User-pinned 3D character model. NULL = auto-pick via claim-and-skip.
  modelOverride: string | null;
}

// Per-role visual layout — desk position, facing, and which GLB to load.
// Unknown roles fall back to ROLE_LAYOUT.default.
export interface RoleLayout {
  position: { x: number; y: number; z: number };
  rotationY: number;
  modelUrl: string;
  /** Body posture at this anchor. Drives idle clip choice (sitting vs
   *  standing) and the hips Y-offset during calibration. Omitted = "sit"
   *  (legacy chairs / desks). */
  posture?: "sit" | "stand";
}

// Dev-only override applied per role: forces the agent into a specific
// chair (workstationId) and/or pins their visible animation status.
// Either field may be `null` (cleared) or undefined (not overridden).
export interface AgentDevOverride {
  workstationId?: string | null;
  status?:        "idle" | "working" | "talking" | "meeting" | null;
}

export type AgentDevOverridesMap = Record<string, AgentDevOverride>;
