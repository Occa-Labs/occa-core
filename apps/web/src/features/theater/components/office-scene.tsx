"use client";

import { Canvas } from "@react-three/fiber";
import { OrbitControls, useProgress } from "@react-three/drei";
import dynamic from "next/dynamic";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { Spinner } from "@/components/ui/spinner";
import type {
  AgentDevOverridesMap,
  AgentStatus,
  CameraMode,
  SceneAgent,
  SceneBounds,
  WalkPhase,
} from "../types";
import { CEO_ROLE } from "@occa/shared/role-catalog";
import {
  GUIDE_POSITION,
  CEO_MEETING_POSITION,
  CEO_MEETING_ROTATION_Y,
  buildAgentModelMap,
  getAgentLayout,
  getRoleLayout,
} from "../constants";
import { OFFICE_WORKSTATIONS } from "../office-anchors";
import {
  buildIdleAssignments,
  buildBoardroomAssignments,
} from "../idle-anchors";
import { WebGLErrorBoundary } from "./webgl-error-boundary";
import { OfficeModel, SceneBoundsScanner, SceneReady } from "./scene-utilities";
import { AgentCharacter } from "./agent-character";
import { GuideCharacter } from "./guide-character";
import { TourGuide } from "./tour-guide";
import { TourDialog } from "./tour-dialog";
import { CameraController } from "./camera-controller";
import { WorkstationFocusHalo } from "./workstation-focus-halo";
import { FloorGrid } from "./dev/floor-grid";

// Dev-only tooling, lazy-loaded so the bundle downloaded by production users
// doesn't include the recorder + HUD code paths. The NODE_ENV check at the
// JSX site keeps these from being fetched at runtime in production.
const WaypointRecorder = dynamic(
  () =>
    import("./dev/waypoint-recorder").then((m) => ({
      default: m.WaypointRecorder,
    })),
  { ssr: false },
);
const DevHudOverlay = dynamic(
  () =>
    import("./dev/dev-hud-overlay").then((m) => ({
      default: m.DevHudOverlay,
    })),
  { ssr: false },
);

interface OfficeSceneProps {
  /** Agents to render in the office. Pre-live phases may include a synthesized
   *  placeholder CEO so the desk isn't empty while the cinematic plays. */
  agents?: SceneAgent[];
  onboardingActive?: boolean;
  onCameraReady?: () => void;
  onSceneBounds?: (bounds: SceneBounds, mapImage: string) => void;
  walkPhase?: WalkPhase;
  onGuideArrived?: () => void;
  devWalkRecord?: boolean;
  /** Role of the agent the camera is currently focused on. Driven from
   *  outside (page.tsx) so window-close can clear focus and return to idle.
   *  When set, OfficeScene flips cameraMode to "agent-focus". */
  focusedAgentRole?: string | null;
  /** Dev-only: workstation id from DevWindow. Takes precedence over
   *  focusedAgentRole — the camera flies to the chair so the user can
   *  visually identify the mapping. */
  focusedWorkstationId?: string | null;
  /** Dev-only per-role overrides for workstation + animation status,
   *  edited from DevWindow's Agents tab. Empty by default in production. */
  agentDevOverrides?: AgentDevOverridesMap;
  /** Fired when the user clicks a clickable agent character. Parent decides
   *  what to do (e.g. open AgentsWindow, set focusedAgentRole). */
  onAgentClick?: (agentId: string) => void;
  /** True while the optional Room Tour cinematic is playing — Jia
   *  spawns and walks the recorded path, camera follows. */
  tourActive?: boolean;
  /** When `tourActive` is true but `tourWalkEnabled` is false, Jia stays
   *  at her spawn point in idle while the camera frames her face-to-face
   *  for an intro line. Flip to true to start the walking tour. */
  tourWalkEnabled?: boolean;
  /** When true, the office model's roof + ceiling stay visible. Default
   *  hidden so the top-down OS camera can see agents inside. The public
   *  /demo route opts in for a closed-building aesthetic. */
  showRoof?: boolean;
  /** Called once Jia returns to her spawn after the round-trip. Parent
   *  flips `tourActive` to false in response. */
  onTourEnd?: () => void;
  /** Current narrator line Jia is speaking (room-tour dialog). Null =
   *  no dialog. Mirrors parent state into TourGuide so it can pause. */
  tourDialog?: string | null;
  /** Called when Jia reaches a waypoint with a `dialog` field. Parent
   *  sets `tourDialog` to this text. */
  onTourDialog?: (text: string) => void;
  /** Called by the TourDialog overlay's auto-dismiss timer. Parent
   *  clears `tourDialog` to null so the tour resumes. */
  onTourDialogDismiss?: () => void;
}

export function OfficeScene({
  agents = [],
  onboardingActive = false,
  onCameraReady,
  onSceneBounds,
  walkPhase = null,
  onGuideArrived,
  devWalkRecord = false,
  focusedAgentRole = null,
  focusedWorkstationId = null,
  agentDevOverrides = {},
  onAgentClick,
  tourActive = false,
  tourWalkEnabled = false,
  showRoof = false,
  onTourEnd,
  tourDialog = null,
  onTourDialog,
  onTourDialogDismiss,
}: OfficeSceneProps) {
  const [sceneLoaded, setSceneLoaded] = useState(false);
  // Local copy of scene bounds — needed by FloorGrid (dev Map tab) to size
  // its raycast plane / grid overlay. Always captured, then forwarded to
  // the optional `onSceneBounds` callback.
  const [localBounds, setLocalBounds] = useState<SceneBounds | null>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>(
    onboardingActive ? "onboarding" : "idle",
  );
  const [devWalking, setDevWalking] = useState(false);
  const [recordedCode, setRecordedCode] = useState<string | null>(null);
  // Marker count from the WaypointRecorder. Resets when recording
  // re-mounts (devWalkRecord toggles back on).
  const [markerCount, setMarkerCount] = useState(0);
  // Bumped each time a new marker fires; lets the HUD flash briefly.
  const [markerFlashAt, setMarkerFlashAt] = useState(0);
  useEffect(() => {
    if (devWalkRecord) {
      setMarkerCount(0);
      setMarkerFlashAt(0);
    }
  }, [devWalkRecord]);
  const [copied, setCopied] = useState(false);

  const prevOnboarding = useRef(onboardingActive);
  const prevWalkPhase = useRef(walkPhase);
  const guidePosRef = useRef(
    new THREE.Vector3(GUIDE_POSITION.x, GUIDE_POSITION.y, GUIDE_POSITION.z),
  );
  const guideForwardRef = useRef(new THREE.Vector3(0, 0, 1));
  const manualPosRef = useRef(
    new THREE.Vector3(GUIDE_POSITION.x, GUIDE_POSITION.y, GUIDE_POSITION.z),
  );

  // Camera mode: onboarding ↔ zoom-out
  useEffect(() => {
    const wasActive = prevOnboarding.current;
    prevOnboarding.current = onboardingActive;
    if (onboardingActive) {
      setCameraMode("onboarding");
    } else if (wasActive && walkPhase === null) {
      setCameraMode("zoom-out");
    }
  }, [onboardingActive, walkPhase]);

  // Camera mode: walk phases. The "meeting" phase routes to agent-focus on
  // the CEO since that's the kickoff cinematic's framing target.
  useEffect(() => {
    const prev = prevWalkPhase.current;
    prevWalkPhase.current = walkPhase;
    if (walkPhase === "walking") setCameraMode("follow-guide");
    else if (walkPhase === "meeting") setCameraMode("agent-focus");
    else if (prev !== null && walkPhase === null && !onboardingActive)
      setCameraMode("zoom-out");
  }, [walkPhase, onboardingActive]);

  // Outside-driven focus: parent sets focusedAgentRole or focusedWorkstationId
  // → enter agent-focus. Clearing both returns to idle (assuming we're not
  // in a cinematic). We skip transitions during onboarding/walk so the
  // cinematic isn't yanked by a stray click or a stale prop.
  useEffect(() => {
    if (onboardingActive || walkPhase !== null) return;
    if (focusedAgentRole || focusedWorkstationId) {
      setCameraMode("agent-focus");
    } else if (cameraMode === "agent-focus") {
      setCameraMode("idle");
    }
  }, [
    focusedAgentRole,
    focusedWorkstationId,
    onboardingActive,
    walkPhase,
    cameraMode,
  ]);

  const handleZoomOutComplete = useCallback(() => setCameraMode("idle"), []);

  // Tour cinematic — flip to the over-the-shoulder `tour-follow` camera
  // while Jia walks the tour, and zoom-out to an overview shot once she
  // wraps the forward leg. The zoom-out camera mode already calls
  // `onZoomOutComplete` once it settles, which kicks the camera back to
  // idle. TourGuide writes Jia's position into `guidePosRef` so the
  // follow camera tracks her through the tour.
  useEffect(() => {
    if (tourActive) {
      setCameraMode(tourWalkEnabled ? "tour-follow" : "tour-intro");
    } else if (cameraMode === "tour-follow" || cameraMode === "tour-intro") {
      setCameraMode("zoom-out");
    }
  }, [tourActive, tourWalkEnabled, cameraMode]);

  const handleCopyRecorded = useCallback(async () => {
    if (!recordedCode) return;
    try {
      await navigator.clipboard.writeText(recordedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* user can select manually */
    }
  }, [recordedCode]);

  const [webglSupported] = useState(() => {
    if (typeof document === "undefined") return true;
    try {
      const c = document.createElement("canvas");
      const gl =
        c.getContext("webgl2", { failIfMajorPerformanceCaveat: false }) ||
        c.getContext("webgl", { failIfMajorPerformanceCaveat: false });
      if (gl) gl.getExtension("WEBGL_lose_context")?.loseContext();
      return !!gl;
    } catch {
      return false;
    }
  });

  // Each hired agent has its own seat (agents.workstation_id, assigned by
  // the server's seat-assignment service at hire time), so we render them
  // all — multiple agents of the same role sit at distinct desks instead
  // of overlapping.
  const renderedAgents = agents;

  // Deterministic per-agent model assignment. Same agent list → same map,
  // so the same agent keeps the same character across renders. Recomputed
  // only when the agents list changes (id, role, or createdAt).
  const agentModels = useMemo(
    () =>
      buildAgentModelMap(
        agents.map((a) => ({
          id: a.id,
          role: a.role,
          createdAt: a.createdAt,
          modelOverride: a.modelOverride,
        })),
      ),
    [agents],
  );

  // Idle / boardroom seat maps. Claim-and-skip across each pool keyed by
  // agentId — guarantees no two agents collide on the same anchor while
  // ≤14 idle (or ≤7 in meeting) at once. Same sort key as agentModels so
  // the three maps stay aligned across renders.
  //
  // The dev "Map" tab (FloorGrid) is intentionally NOT wired in here:
  // painted cells are a *data collection surface* only. The user copies
  // them out via "Copy as code" and pastes into idle-anchors.ts as
  // hardcoded defaults — agents render from the canonical pool, never
  // from in-progress mapping data.
  // Filter to the agents that actually need a lounge / boardroom anchor.
  // Round-robin over the full roster would burn slots on working agents
  // (who render at their desk) and force later meeting/idle agents to
  // collide on a seat that's already claimed by someone not even sitting
  // in it — visible as two characters stacked on the same chair.
  // Tick that re-evaluates idle anchor assignments. Each agent has its
  // own ~35s dwell window inside `buildIdleAssignments`; bumping this
  // every 5s gives us enough resolution to catch each agent's epoch
  // flip soon after it happens without re-rendering the whole scene
  // every frame.
  const [idleNow, setIdleNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setIdleNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);
  const idleAssignments = useMemo(
    () =>
      buildIdleAssignments(
        agents
          .filter((a) => a.status === "idle" && a.ready)
          .map((a) => ({ id: a.id, createdAt: a.createdAt })),
        idleNow,
      ),
    [agents, idleNow],
  );
  const boardroomAssignments = useMemo(
    () =>
      buildBoardroomAssignments(
        agents
          .filter((a) => a.status === "meeting")
          .map((a) => ({ id: a.id, createdAt: a.createdAt })),
      ),
    [agents],
  );

  // Clicks are gated to non-cinematic phases. During onboarding/walk the
  // camera is locked into a specific cinematic shot — letting the user
  // override that by clicking a character would break the flow.
  const clicksEnabled = !onboardingActive && walkPhase === null;

  // For agent-focus mode CameraController needs a layout (position +
  // rotationY) for the target. Workstation focus from DevWindow takes
  // precedence over agent focus — the chair is what the user wants to see.
  const focusLayout = useMemo(() => {
    if (focusedWorkstationId) {
      const ws = OFFICE_WORKSTATIONS[focusedWorkstationId];
      if (ws) {
        return { position: ws.position, rotationY: ws.rotationY, modelUrl: "" };
      }
    }
    if (!focusedAgentRole) return null;
    return getRoleLayout(focusedAgentRole);
  }, [focusedAgentRole, focusedWorkstationId]);

  // During the kickoff "meeting" cinematic the focus target is implicitly
  // the CEO at the onboarding meeting spot (anchored to the walk path),
  // NOT at her desk. CameraController gets a synthetic layout pointing
  // at CEO_MEETING_POSITION even though parent hasn't set
  // focusedAgentRole.
  const effectiveFocusLayout = useMemo(() => {
    if (cameraMode === "agent-focus" && !focusLayout) {
      if (walkPhase !== null) {
        const ceoModel = getRoleLayout(CEO_ROLE).modelUrl;
        return {
          position: {
            x: CEO_MEETING_POSITION.x,
            y: CEO_MEETING_POSITION.y,
            z: CEO_MEETING_POSITION.z,
          },
          rotationY: CEO_MEETING_ROTATION_Y,
          modelUrl: ceoModel,
        };
      }
      return getRoleLayout(CEO_ROLE);
    }
    return focusLayout;
  }, [cameraMode, focusLayout, walkPhase]);

  const webglFallback = (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-white">
      <p className="text-lg font-semibold">WebGL Unavailable</p>
      <p className="max-w-sm text-center text-sm text-white/50">
        Your browser cannot create a WebGL context. Enable hardware acceleration
        in browser settings or try a different browser.
      </p>
    </div>
  );

  const guideVisible =
    devWalkRecord ||
    onboardingActive ||
    walkPhase === "walking" ||
    walkPhase === "meeting";
  const guideWalking = walkPhase === "walking" || (devWalkRecord && devWalking);
  const effectiveCamMode = devWalkRecord ? "idle" : cameraMode;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "var(--app-bg-scene)",
        position: "relative",
      }}
    >
      {/* Blurred photo backdrop sits behind the transparent Canvas so the 3D
       *  office composites over a soft, defocused real-world tone. The
       *  scale(1.08) hides edge bleeding from the heavy blur. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: "url(/images/background.jpg)",
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
          filter: "blur(28px) saturate(1.1) brightness(0.7)",
          transform: "scale(1.08)",
        }}
      />

      {!webglSupported ? (
        webglFallback
      ) : (
        <WebGLErrorBoundary fallback={webglFallback}>
          <Canvas
            dpr={[1, 1.5]}
            performance={{ min: 0.5 }}
            gl={{ alpha: true, antialias: true }}
            style={{ background: "transparent" }}
            camera={{ position: [30, 25, 30], fov: 50, near: 0.1, far: 200 }}
          >
            <ambientLight intensity={0.8} />
            <directionalLight position={[20, 30, 20]} intensity={1.5} />
            <directionalLight position={[-10, 20, -10]} intensity={0.5} />

            <Suspense fallback={null}>
              <OfficeModel showRoof={showRoof} />
              {renderedAgents.map((agent) => {
                // Layout reads agent.workstationId (server-assigned at hire
                // time). DevWindow can override the workstation per-role;
                // we keep the GLB model from the role-based layout.
                const baseLayout = getAgentLayout(
                  agent,
                  agentModels.get(agent.id),
                );
                const override = agentDevOverrides[agent.role];
                const overrideWs = override?.workstationId
                  ? OFFICE_WORKSTATIONS[override.workstationId]
                  : null;
                // DevWindow can also pin the animation status. Cast is safe:
                // override.status is constrained to the AgentStatus subset.
                const status: AgentStatus = override?.status ?? agent.status;
                // Status-driven placement: idle agents leave their desk and
                // wander to a lounge / lobby / standing spot; meeting status
                // routes them to the boardroom. Working / talking / pre-ready
                // states stay at the assigned workstation. A workstation
                // override from DevWindow always wins (lets a dev pin a
                // specific seat regardless of status).
                //
                // Onboarding cinematic: while Jia is walking to / meeting
                // the CEO, the CEO must stand at the meeting spot anchored
                // to the walk path (not at her desk — desk position is
                // server-driven and may have drifted from the recorded
                // path). This override beats every other rule below.
                const isOnboardingCeoMeeting =
                  agent.role === CEO_ROLE && walkPhase !== null;
                const layout = isOnboardingCeoMeeting
                  ? {
                      position: {
                        x: CEO_MEETING_POSITION.x,
                        y: CEO_MEETING_POSITION.y,
                        z: CEO_MEETING_POSITION.z,
                      },
                      rotationY: CEO_MEETING_ROTATION_Y,
                      modelUrl: baseLayout.modelUrl,
                      posture: "stand" as const,
                    }
                  : overrideWs
                    ? {
                        position: overrideWs.position,
                        rotationY: overrideWs.rotationY,
                        modelUrl: baseLayout.modelUrl,
                      }
                    : status === "idle" && agent.ready
                      ? (() => {
                          const a = idleAssignments.get(agent.id);
                          if (!a) return baseLayout;
                          // Sit anchors are painted at the cell center, but
                          // the character's hips need a small bias forward
                          // (deeper into the seat) and up (sofas/benches sit
                          // a touch higher than the default chair). Stand
                          // anchors stay where the user pinned them.
                          const SIT_FORWARD = 0.2;
                          const SIT_HEIGHT = -0.1;
                          const isSit = a.posture === "sit";
                          const fx = isSit
                            ? Math.sin(a.rotationY) * SIT_FORWARD
                            : 0;
                          const fz = isSit
                            ? Math.cos(a.rotationY) * SIT_FORWARD
                            : 0;
                          const dy = isSit ? SIT_HEIGHT : 0;
                          return {
                            position: {
                              x: a.position.x + fx,
                              y: a.position.y + dy,
                              z: a.position.z + fz,
                            },
                            rotationY: a.rotationY,
                            modelUrl: baseLayout.modelUrl,
                            posture: a.posture,
                          };
                        })()
                      : status === "meeting"
                        ? (() => {
                            // Honour an explicit boardroom workstationId on
                            // the agent — that's how /demo pins exact seats.
                            // Real-OS agents have a cubicle workstationId, so
                            // they fall through to the round-robin map.
                            const pinned =
                              agent.workstationId &&
                              agent.workstationId.startsWith("boardroom-")
                                ? OFFICE_WORKSTATIONS[agent.workstationId]
                                : null;
                            const seat =
                              pinned ??
                              (() => {
                                const id = boardroomAssignments.get(agent.id);
                                return id ? OFFICE_WORKSTATIONS[id] : null;
                              })();
                            return seat
                              ? {
                                  position: seat.position,
                                  rotationY: seat.rotationY,
                                  modelUrl: baseLayout.modelUrl,
                                }
                              : baseLayout;
                          })()
                        : baseLayout;
                // Only ready agents with a real id are clickable. The
                // synthesized placeholder CEO and pre-`ready` agents have
                // no AgentsWindow row to surface.
                const clickable =
                  clicksEnabled && agent.ready && !!onAgentClick;
                // Key by agent id so each hire has a stable mount even when
                // multiple agents share a role.
                // Per-character Suspense — when an agent's posture flips
                // (sit ↔ stand) the idleAnimUrl changes and the FBX
                // re-suspends. Without this isolation the parent Suspense
                // would blank the entire scene every time, causing the
                // visible flicker.
                return (
                  <Suspense key={agent.id} fallback={null}>
                    <AgentCharacter
                      role={agent.role}
                      layout={layout}
                      status={status}
                      ready={agent.ready}
                      onClick={
                        clickable ? () => onAgentClick!(agent.id) : undefined
                      }
                    />
                  </Suspense>
                );
              })}
              <Suspense fallback={null}>
                <GuideCharacter
                  visible={guideVisible}
                  walking={guideWalking}
                  onArrived={onGuideArrived}
                  posRef={guidePosRef}
                  forwardRef={guideForwardRef}
                  manualPosRef={devWalkRecord ? manualPosRef : null}
                />
              </Suspense>
              <TourGuide
                active={tourActive}
                walkEnabled={tourWalkEnabled}
                onTourEnd={onTourEnd}
                posRef={guidePosRef}
                forwardRef={guideForwardRef}
                onDialog={onTourDialog}
                currentDialog={tourDialog}
              />
              <CameraController
                mode={effectiveCamMode}
                focusLayout={effectiveFocusLayout}
                focusAerial={!!focusedWorkstationId}
                onReady={onCameraReady ?? (() => {})}
                onZoomOutComplete={handleZoomOutComplete}
                guidePosRef={guidePosRef}
                guideForwardRef={guideForwardRef}
              />
              {focusedWorkstationId &&
                OFFICE_WORKSTATIONS[focusedWorkstationId] && (
                  <WorkstationFocusHalo
                    position={
                      OFFICE_WORKSTATIONS[focusedWorkstationId].position
                    }
                  />
                )}
              <SceneReady onReady={() => setSceneLoaded(true)} />
              <SceneBoundsScanner
                onBounds={(b, img) => {
                  setLocalBounds(b);
                  onSceneBounds?.(b, img);
                }}
              />
              {process.env.NODE_ENV === "development" && (
                <FloorGrid bounds={localBounds} />
              )}
              {devWalkRecord && process.env.NODE_ENV === "development" && (
                <WaypointRecorder
                  manualPosRef={manualPosRef}
                  forwardRef={guideForwardRef}
                  onWalkingChange={setDevWalking}
                  onMarkerCount={(c) => {
                    setMarkerCount(c);
                    setMarkerFlashAt(performance.now());
                  }}
                  onRecorded={setRecordedCode}
                />
              )}
            </Suspense>

            <OrbitControls
              makeDefault
              enabled={effectiveCamMode === "idle" && !devWalkRecord}
              minDistance={5}
              maxDistance={80}
              maxPolarAngle={Math.PI / 2.1}
              enableDamping
              dampingFactor={0.05}
              target={[0, 0, 5]}
            />
          </Canvas>
        </WebGLErrorBoundary>
      )}

      {process.env.NODE_ENV === "development" && (
        <DevHudOverlay
          active={devWalkRecord}
          recordedCode={recordedCode}
          copied={copied}
          onCopy={handleCopyRecorded}
          onCloseModal={() => setRecordedCode(null)}
          markerCount={markerCount}
          markerFlashAt={markerFlashAt}
        />
      )}

      {webglSupported && <SceneLoadingOverlay sceneReady={sceneLoaded} />}

      {/* Room-tour narration overlay. Mounts only while the tour is
          active; auto-dismisses after the line types in + read time. */}
      {tourActive && (
        <TourDialog
          text={tourDialog}
          onDismiss={onTourDialogDismiss ?? (() => {})}
        />
      )}
    </div>
  );
}

const FADE_DURATION_MS = 400;

// Loading overlay with live progress + fade-out. `sceneReady` flips true
// once <SceneReady> fires (post gl.compile + 1 RAF) — that's our cue to
// fade. We hold the overlay mounted for FADE_DURATION_MS more so the
// opacity transition can play before unmount.
function SceneLoadingOverlay({ sceneReady }: { sceneReady: boolean }) {
  const { progress, active } = useProgress();
  const [unmounted, setUnmounted] = useState(false);
  // Show real progress while assets stream in. Once sceneReady fires we
  // pin to 100 so the number doesn't visually rewind during the fade.
  const displayProgress = sceneReady ? 100 : Math.min(progress, 99);

  useEffect(() => {
    if (!sceneReady) return;
    const id = setTimeout(() => setUnmounted(true), FADE_DURATION_MS);
    return () => clearTimeout(id);
  }, [sceneReady]);

  if (unmounted) return null;

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 pointer-events-none transition-opacity"
      style={{
        background: "var(--app-bg-loading)",
        opacity: sceneReady ? 0 : 1,
        transitionDuration: `${FADE_DURATION_MS}ms`,
      }}
    >
      <Spinner className="size-8 text-white" />
      <p className="text-sm text-white tabular-nums">
        {active || !sceneReady
          ? `Loading office… ${Math.round(displayProgress)}%`
          : "Loading office…"}
      </p>
    </div>
  );
}
