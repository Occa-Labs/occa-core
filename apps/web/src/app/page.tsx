"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/features/auth/hooks/use-auth";
import { SetupWorkflow } from "@/features/setup/components/setup-workflow";
import { useSetupWorkflow } from "@/features/setup/hooks/use-setup-workflow";
import { Spinner } from "@/components/ui/spinner";
import { useViewMode } from "@/shell/view-mode-toggle";
import { TopMenuBar } from "@/shell/top-menu-bar";
import { DesktopOnlyGate } from "@/shell/desktop-only-gate";
import { DevResetButton } from "@/components/dev-reset-button";
import { LandingFab } from "@/features/auth/components/landing-fab";
import { AnchorReminderBanner } from "@/features/setup/components/anchor-reminder-banner";
import type { SceneAgent } from "@/features/theater/types";
import { deriveAgentStatus } from "@/features/theater/utils";
import { CEO_ROLE } from "@occa/shared/role-catalog";

const OfficeScene = dynamic(
  () =>
    import("@/features/theater/components/office-scene").then(
      (mod) => mod.OfficeScene,
    ),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex h-full w-full items-center justify-center"
        style={{ background: "var(--app-bg-loading)" }}
      >
        <Spinner className="size-8 text-white" />
      </div>
    ),
  },
);

const OsShell = dynamic(
  () => import("@/shell/os-shell").then((mod) => mod.OsShell),
  { ssr: false },
);

export default function HomePage() {
  const { status: authStatus } = useAuth();
  const authenticated = authStatus === "authenticated";

  // Single state machine owning the entire first-run arc (onboarding →
  // kickoff → hiring → live). useOnboarding + useMe are owned by the hook;
  // page reads `phase` + `walkPhase` for OfficeScene, drills the hook
  // return into <SetupWorkflow> for the dialogs.
  const setup = useSetupWorkflow({ authenticated });
  const {
    phase,
    walkPhase,
    onboardingActive,
    me,
    handleGuideArrived,
    showAnchorReminder,
    handleAnchorResumeFromBanner,
  } = setup;

  // Camera-ready gate: fires once the camera has finished lerping into the
  // onboarding position in front of Jia. Until then we suppress dialogs so
  // they don't pop in over a scene that's still loading / animating. Sticky
  // after the first ready signal.
  const [cameraReady, setCameraReady] = useState(false);
  const handleCameraReady = useCallback(() => setCameraReady(true), []);

  // CameraController only fires `onReady` while the camera lerps into the
  // onboarding pose (`mode === "onboarding"`). On a browser reload,
  // returning users with completed onboarding skip the cinematic and land
  // directly on a post-onboarding SetupWorkflow phase
  // (kickoff-form / hiring / kickoff-complete) where the camera goes into
  // agent-focus — so `onReady` never fires and the dialog never shows.
  // Unblock the gate as soon as we see one of those reload-only phases.
  useEffect(() => {
    if (cameraReady) return;
    if (
      phase === "kickoff-form" ||
      phase === "deploying-team" ||
      phase === "kickoff-complete"
    ) {
      setCameraReady(true);
    }
  }, [phase, cameraReady]);

  // 3D office vs flat background. Setup phases need the scene to fire
  // walk + camera-ready events. In `live` we honor the user's view-mode
  // toggle; everywhere else the scene stays mounted.
  const view = useViewMode();
  const showScene = phase !== "live" || view.enabled;

  // Build the per-agent scene roster. We override the CEO's status to
  // "talking" while the user is mid-conversation (kickoff form / post-walk
  // intro). When no real CEO exists yet (pre-provisioning, walk cinematic),
  // synthesize a placeholder so the desk isn't empty during the walk.
  const agentsForScene: SceneAgent[] = useMemo(() => {
    const ceoOverride =
      phase === "ceo-intro" ||
      phase === "kickoff-form" ||
      phase === "kickoff-complete";

    const real = me.agents
      .filter((a) => a.provisioningState !== "failed")
      .map<SceneAgent>((a) => {
        const baseStatus = deriveAgentStatus(a);
        const status =
          a.role === CEO_ROLE && ceoOverride ? "talking" : baseStatus;
        return {
          id: a.id,
          role: a.role,
          name: a.name,
          status,
          ready: a.provisioningState === "ready",
          workstationId: a.workstationId,
          createdAt: a.createdAt,
          modelOverride: a.modelOverride,
        };
      });

    if (!real.some((a) => a.role === CEO_ROLE)) {
      real.unshift({
        id: "placeholder-ceo",
        role: CEO_ROLE,
        name: "CEO",
        status: ceoOverride ? "talking" : "idle",
        ready: false,
        workstationId: null,
        // Sort to the start so the placeholder claims CEO's preferred
        // model before any real agent.
        createdAt: "0000-01-01T00:00:00.000Z",
        modelOverride: null,
      });
    }
    return real;
  }, [me.agents, phase]);

  // Click-to-focus state shared between the 3D office and OsShell. Click
  // an agent in the scene → set focusedAgentId → OsShell auto-opens
  // AgentsWindow with that agent selected, and the 3D camera lerps to
  // the agent's desk via focusedAgentRole. Clearing returns the camera
  // to overview and lets the user close the window normally.
  const [focusedAgentId, setFocusedAgentId] = useState<string | null>(null);

  // Reset focus on phase exits — pre-live phases own the camera, and a
  // stale id would confuse OsShell on re-entry.
  useEffect(() => {
    if (phase !== "live") setFocusedAgentId(null);
  }, [phase]);

  const focusedAgentRole = useMemo(() => {
    if (!focusedAgentId) return null;
    return me.agents.find((a) => a.id === focusedAgentId)?.role ?? null;
  }, [focusedAgentId, me.agents]);

  const handleAgentClick = useCallback((agentId: string) => {
    setFocusedAgentId(agentId);
  }, []);

  const handleClearFocus = useCallback(() => {
    setFocusedAgentId(null);
  }, []);

  // Dev-only: waypoint recorder for capturing Jia's walk paths. Toggled
  // from the Dev window's "Record" tab. When true, OfficeScene mounts
  // WaypointRecorder and the on-screen HUD; toggling back to false
  // emits the recorded path through the modal.
  const [devWalkRecord, setDevWalkRecord] = useState(false);
  const handleToggleWalkRecord = useCallback(() => {
    setDevWalkRecord((v) => !v);
  }, []);

  // "Room Tour" cinematic — Jia spawns and walks the recorded tour path,
  // then returns to her spawn and disappears. Triggered by the user from
  // the Settings window; only available in `live` phase. The state is
  // ephemeral (no localStorage persistence) so a refresh always lands
  // back in regular live view.
  const [tourActive, setTourActive] = useState(false);
  // Current line Jia is narrating during the room tour. Null = no dialog.
  // TourGuide fires `onTourDialog` to set this; TourDialog auto-dismiss
  // calls `clearTourDialog` once the line's read-time elapses.
  const [tourDialog, setTourDialog] = useState<string | null>(null);
  const handleStartTour = useCallback(() => {
    if (phase !== "live") return;
    setTourActive(true);
    setTourDialog(null);
  }, [phase]);
  const handleTourEnd = useCallback(() => {
    setTourActive(false);
    setTourDialog(null);
  }, []);
  const handleTourDialog = useCallback((text: string) => {
    setTourDialog(text);
  }, []);
  const clearTourDialog = useCallback(() => {
    setTourDialog(null);
  }, []);
  // Defensively kill an in-flight tour if the phase ever leaves `live`
  // (e.g. a forced reset). Keeps the cinematic from leaking into
  // pre-live screens where Jia plays a different role.
  useEffect(() => {
    if (phase !== "live" && tourActive) setTourActive(false);
  }, [phase, tourActive]);

  // Dev-only: focus the camera on a workstation (chair+desk pair) so the
  // user can visually identify which entry maps to which physical desk.
  // Cleared either by Esc / re-clicking the focused card or by clicking
  // an agent in the scene (which prefers agent focus).
  const [focusedWorkstationId, setFocusedWorkstationId] = useState<
    string | null
  >(null);
  const handleFocusWorkstation = useCallback((id: string | null) => {
    setFocusedWorkstationId(id);
    // A new agent-click should override workstation focus, so we don't
    // clear focusedAgentId here — instead OfficeScene gives workstation
    // focus precedence only when its id is non-null.
  }, []);

  // Dev-only: per-role overrides for workstation and animation status.
  // Lets DevWindow seat any agent at any chair and force their animation
  // state (idle/working/talking) without going through the runtime.
  // Persisted to localStorage so a refresh keeps the test setup; key is
  // namespaced under `occa.dev.*` to make it easy to spot + clear.
  type AgentDevOverridesShape = Record<
    string,
    {
      workstationId?: string | null;
      status?: "idle" | "working" | "talking" | "meeting" | null;
    }
  >;
  const DEV_OVERRIDES_KEY = "occa.dev.agent-overrides";
  const [agentDevOverrides, setAgentDevOverrides] =
    useState<AgentDevOverridesShape>(() => {
      if (typeof window === "undefined") return {};
      try {
        const raw = window.localStorage.getItem(DEV_OVERRIDES_KEY);
        return raw ? (JSON.parse(raw) as AgentDevOverridesShape) : {};
      } catch {
        return {};
      }
    });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        DEV_OVERRIDES_KEY,
        JSON.stringify(agentDevOverrides),
      );
    } catch {
      /* quota exceeded / private mode — ignore, dev-only */
    }
  }, [agentDevOverrides]);
  const updateAgentDevOverride = useCallback(
    (
      role: string,
      patch: {
        workstationId?: string | null;
        status?: "idle" | "working" | "talking" | "meeting" | null;
      },
    ) => {
      setAgentDevOverrides((prev) => ({
        ...prev,
        [role]: { ...prev[role], ...patch },
      }));
    },
    [],
  );

  return (
    <DesktopOnlyGate>
    <main
      className="fixed inset-0 h-screen w-screen overflow-hidden"
      style={{ background: "var(--app-bg-scene)" }}
    >
      {showScene ? (
        <OfficeScene
          agents={agentsForScene}
          onboardingActive={onboardingActive}
          walkPhase={walkPhase}
          onGuideArrived={handleGuideArrived}
          onCameraReady={handleCameraReady}
          focusedAgentRole={focusedAgentRole}
          focusedWorkstationId={focusedWorkstationId}
          agentDevOverrides={agentDevOverrides}
          onAgentClick={handleAgentClick}
          tourActive={tourActive}
          onTourEnd={handleTourEnd}
          tourDialog={tourDialog}
          onTourDialog={handleTourDialog}
          onTourDialogDismiss={clearTourDialog}
          devWalkRecord={devWalkRecord}
        />
      ) : (
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: "url(/images/background.jpg)",
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
          }}
        />
      )}
      <TopMenuBar
        notificationsEnabled={authenticated && phase === "live"}
        viewMode3d={view.enabled}
        onToggleViewMode={view.toggle}
        viewModeToggleEnabled={phase === "live"}
      />
      {cameraReady && <SetupWorkflow setup={setup} />}
      {!authenticated && <LandingFab />}
      {phase === "live" && (
        <OsShell
          me={me}
          focusedAgentId={focusedAgentId}
          onClearFocus={handleClearFocus}
          focusedWorkstationId={focusedWorkstationId}
          onFocusWorkstation={handleFocusWorkstation}
          agentDevOverrides={agentDevOverrides}
          onUpdateAgentDevOverride={updateAgentDevOverride}
          onStartTour={handleStartTour}
          tourActive={tourActive}
          devWalkRecord={devWalkRecord}
          onToggleWalkRecord={handleToggleWalkRecord}
        />
      )}
      {phase === "live" && showAnchorReminder && (
        <AnchorReminderBanner
          pendingCount={
            me.agents.filter(
              (a) =>
                a.role !== CEO_ROLE && a.agentChainTxSignature === null,
            ).length
          }
          onResume={handleAnchorResumeFromBanner}
        />
      )}
      {process.env.NODE_ENV === "development" &&
        authenticated &&
        phase !== "live" && <DevResetButton />}
    </main>
    </DesktopOnlyGate>
  );
}
