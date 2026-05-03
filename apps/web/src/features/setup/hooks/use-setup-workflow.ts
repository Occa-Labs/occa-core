"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WalkPhase } from "@/features/theater/types";
import { useOnboarding, type UseOnboardingResult } from "@/hooks/use-onboarding";
import { useMe, type UseMeResult } from "@/hooks/use-me";
import type { SetupPhase } from "../types";

interface UseSetupWorkflowArgs {
  authenticated: boolean;
}

// Sub-stage tracked locally during the post-onboarding cinematic. Only
// meaningful while `introCompleted === false`. After the user clicks
// through CeoIntroDialog, `introCompleted` flips to true and the phase
// derivation falls through to the data-driven branch (kickoffState).
//
// On a browser refresh both flags reset to defaults — `introCompleted=false`
// + `walkStage=null` — and derivation proceeds straight to the kickoff
// branch via the data check. Refresh skips the replay; that matches the
// old machine's behaviour.
type WalkStage = "ceo-ready" | "walking" | "ceo-intro" | null;

export interface UseSetupWorkflowReturn {
  phase: SetupPhase;
  walkPhase: WalkPhase;
  /** True while the user is in pre-live phases (any dialog/walk/hiring).
   *  Mirrors the old `onboardingActive` for the OfficeScene's camera mode. */
  onboardingActive: boolean;
  /** Underlying hooks — still passed down to dialogs that need their full
   *  surface (e.g. <OnboardingFormDialog onboarding={...}>). Don't re-call
   *  these in <SetupWorkflow> children — read from the hook return instead. */
  onboarding: UseOnboardingResult;
  me: UseMeResult;
  // Edge handlers — child dialogs invoke these to advance the machine.
  handleFormReady: () => void;
  handleRetryLaunch: () => void;
  handleStartWalk: () => void;
  handleGuideArrived: () => void;
  handleIntroDone: () => void;
  handleKickoffStarted: () => void;
  handleHiringCompleted: () => void;
  handleHiringReset: () => void;
  /** User clicked "Enter your office" on the kickoff summary screen. */
  handleEnterOffice: () => void;
}

export function useSetupWorkflow({
  authenticated,
}: UseSetupWorkflowArgs): UseSetupWorkflowReturn {
  const onboarding = useOnboarding(authenticated);
  const me = useMe(authenticated);

  const [walkStage, setWalkStage] = useState<WalkStage>(null);
  const [introCompleted, setIntroCompleted] = useState(false);
  // Set on the in-session edge `kickoffState=provisioning → completed`.
  // Holds the user on a summary screen (with retry-failed-hire buttons +
  // "Enter your office" CTA) instead of slamming them straight into
  // OsShell. Reset to false after the user clicks through. On a refresh
  // landing on `kickoffState=completed` directly we DON'T set this — the
  // user's already past it from a previous session.
  const [showKickoffSummary, setShowKickoffSummary] = useState(false);

  // Latch onto the launch-success edge so we can fire `me.reload()` exactly
  // once and seed walkStage. Keying on the previous status avoids
  // re-triggering on later renders where status stays at "complete".
  const prevOnboardingKindRef = useRef(onboarding.status.kind);

  // Stable reload reference — avoids re-firing the launch-edge effect
  // every time TanStack hands back a new function identity.
  const meReload = me.reload;

  useEffect(() => {
    const prev = prevOnboardingKindRef.current;
    const kind = onboarding.status.kind;
    prevOnboardingKindRef.current = kind;

    if (kind === "complete" && prev !== "complete") {
      // Onboarding just succeeded. Refresh `me` so the company row +
      // kickoffState are ready by the time the user clicks past
      // CeoReadyDialog → walking → CeoIntroDialog. Without this, the
      // kickoff dialog would appear with a delay (waiting for the next
      // 10s useMe tick) — the gap bug the user reported.
      void meReload();
      // Seed the cinematic. Only walkStage="ceo-ready" → "walking" →
      // "ceo-intro" → null is allowed; later refresh (introCompleted
      // already true) won't re-enter this branch because prev will
      // already be "complete".
      setWalkStage("ceo-ready");
      setIntroCompleted(false);
    }
  }, [onboarding.status.kind, meReload]);

  // Kickoff-state edge: `provisioning → completed` means the user just
  // finished hiring this session. Pin them on the summary screen until
  // they explicitly click "Enter your office" — auto-jumping to OsShell
  // hides which hires failed (e.g. gateway rate-limit on the last 1-2
  // agents in a 5-hire batch) and removes the only place to retry them.
  const prevKickoffStateRef = useRef<string | null>(
    me.company?.kickoffState ?? null,
  );
  useEffect(() => {
    const current = me.company?.kickoffState ?? null;
    const prev = prevKickoffStateRef.current;
    prevKickoffStateRef.current = current;
    if (current === "completed" && prev === "provisioning") {
      setShowKickoffSummary(true);
    }
  }, [me.company?.kickoffState]);

  const handleFormReady = useCallback(() => {
    void onboarding.launch();
  }, [onboarding]);

  const handleRetryLaunch = useCallback(() => {
    void onboarding.launch();
  }, [onboarding]);

  const handleStartWalk = useCallback(() => {
    setWalkStage("walking");
  }, []);

  const handleGuideArrived = useCallback(() => {
    setWalkStage("ceo-intro");
  }, []);

  const handleIntroDone = useCallback(() => {
    setIntroCompleted(true);
    setWalkStage(null);
    // me already refreshed at the launch-success edge above; no second
    // reload here. If the user took a long time through the cinematic,
    // useMe's regular 10s polling has been keeping the cache fresh.
  }, []);

  const handleKickoffStarted = useCallback(() => {
    void meReload();
  }, [meReload]);

  const handleHiringCompleted = useCallback(() => {
    void meReload();
  }, [meReload]);

  const handleHiringReset = useCallback(() => {
    void meReload();
  }, [meReload]);

  const handleEnterOffice = useCallback(() => {
    setShowKickoffSummary(false);
  }, []);

  // ── Phase derivation ─────────────────────────────────────────────────────
  // Order matters: cinematic walkStage takes precedence over data-driven
  // kickoff branches so a user mid-intro doesn't get yanked into
  // kickoff-form by an out-of-band useMe refetch.
  const phase: SetupPhase = useMemo(() => {
    if (!authenticated) return "idle";
    const onboardingKind = onboarding.status.kind;
    if (onboardingKind === "loading") return "idle";
    if (onboardingKind === "needed") return "onboarding-form";
    if (onboardingKind === "submitting" || onboardingKind === "error") {
      return "provisioning-ceo";
    }
    // onboardingKind is "complete" or "not_needed" beyond this point.

    // Cinematic in flight (only valid right after launch-success edge).
    if (!introCompleted && walkStage !== null) {
      switch (walkStage) {
        case "ceo-ready":
          return "ceo-ready";
        case "walking":
          return "walking";
        case "ceo-intro":
          return "ceo-intro";
      }
    }

    // Data-driven branch — kickoff lifecycle on the company row.
    const kickoffState = me.company?.kickoffState ?? null;
    if (me.company === null) {
      // Edge case: onboarding said complete/not_needed but me hasn't
      // returned yet. Hold idle until it does — refresh fired above will
      // unstick this within one round-trip.
      return "idle";
    }
    if (kickoffState === "not_started") return "kickoff-form";
    if (kickoffState === "provisioning") return "hiring";
    if (kickoffState === "completed") {
      return showKickoffSummary ? "kickoff-complete" : "live";
    }
    return "idle";
  }, [
    authenticated,
    onboarding.status.kind,
    walkStage,
    introCompleted,
    me.company,
    showKickoffSummary,
  ]);

  // walkPhase is a pure projection of phase. Crucially, it does NOT read
  // me.kickoffState — that was the source of the "Jia teleports" bug,
  // where a polling refetch landing during phase=walking flipped
  // walkPhase to "meeting" and snapped the camera to the CEO. Here a
  // polling refetch can't reach into the projection at all.
  const walkPhase: WalkPhase = useMemo(() => {
    if (phase === "walking") return "walking";
    if (
      phase === "ceo-intro" ||
      phase === "kickoff-form" ||
      phase === "hiring" ||
      phase === "kickoff-complete"
    ) {
      return "meeting";
    }
    return null;
  }, [phase]);

  const onboardingActive =
    phase === "onboarding-form" ||
    phase === "provisioning-ceo" ||
    phase === "ceo-ready";

  return {
    phase,
    walkPhase,
    onboardingActive,
    onboarding,
    me,
    handleFormReady,
    handleRetryLaunch,
    handleStartWalk,
    handleGuideArrived,
    handleIntroDone,
    handleKickoffStarted,
    handleHiringCompleted,
    handleHiringReset,
    handleEnterOffice,
  };
}
