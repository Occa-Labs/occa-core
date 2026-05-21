"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WalkPhase } from "@/features/theater/types";
import {
  useOnboarding,
  type UseOnboardingResult,
} from "./use-onboarding";
import { useMe, type UseMeResult } from "@/hooks/use-me";
import { CEO_ROLE } from "@occa/shared/role-catalog";
import type { SetupPhase } from "../types";
import {
  clearKickoffAnchorSkip,
  clearKickoffResolved,
  isKickoffAnchorSkipped,
  isKickoffResolved,
  markKickoffAnchorSkipped,
  markKickoffResolved,
} from "../lib/kickoff-anchor-skip";

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
  handleDeployTeamCompleted: () => void;
  handleDeployTeamReset: () => void;
  /** User clicked "Skip for now" on the kickoff anchor panel. Persists
   *  the decision per-company; the OS shell shows a reminder banner
   *  until anchor is actually completed. */
  handleAnchorSkip: () => void;
  /** Banner click handler — clears the skip flag so phase derivation
   *  flips back to `deploying-team` and KickoffWindow re-mounts. */
  handleAnchorResumeFromBanner: () => void;
  /** True when user previously skipped anchor for the current company
   *  AND there are still un-anchored deployments. The OS shell uses
   *  this to render the reminder banner. */
  showAnchorReminder: boolean;
  /** Session-only dismiss for the AnchorReminderBanner. Hides until the
   *  next page refresh (skip flag in localStorage stays set). */
  handleDismissAnchorBanner: () => void;
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

  // Persistent "skipped batch anchor" flag — survives page refresh so
  // the user isn't dragged back into KickoffWindow every reload. Kept
  // in React state so phase derivation re-runs when toggled; mirror to
  // localStorage. Hydrate from storage once company id is known.
  const [anchorSkipped, setAnchorSkipped] = useState(false);
  useEffect(() => {
    const cid = me.company?.id;
    if (!cid) return;
    setAnchorSkipped(isKickoffAnchorSkipped(cid));
  }, [me.company?.id]);

  // Sticky "kickoff phase has been resolved" flag. Flips true once the
  // user first leaves the kickoff summary (success OR skip path). After
  // that, ad-hoc agent deploys are anchored by their own
  // DeployAgentModal — un-anchored ad-hoc agents must NOT yank the user
  // back into KickoffWindow. Banner click clears this so the user can
  // explicitly re-enter the batch flow for any leftover kickoff-era
  // skipped agents.
  const [kickoffResolved, setKickoffResolved] = useState(false);
  useEffect(() => {
    const cid = me.company?.id;
    if (!cid) return;
    setKickoffResolved(isKickoffResolved(cid));
  }, [me.company?.id]);

  // Session-only dismiss for the AnchorReminderBanner. Resets on refresh
  // by design — skip flag (localStorage) persists, dismiss does not.
  const [anchorBannerDismissed, setAnchorBannerDismissed] = useState(false);
  const handleDismissAnchorBanner = useCallback(() => {
    setAnchorBannerDismissed(true);
  }, []);

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

  // We DON'T auto-flip showKickoffSummary on the `provisioning →
  // completed` edge here, because that fires the moment the server
  // marks the kickoff done — yanking the user out of KickoffWindow
  // before they can click the on-chain anchor button. The summary
  // toggle is now driven by the KickoffWindow's own onCompleted
  // callback (handleDeployTeamCompleted below), which fires after the
  // user has explicitly anchored or skipped.

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

  // Fired by KickoffWindow once provisioning + on-chain anchor (or
  // explicit skip) are both done. Pinning the summary screen here —
  // not on the server kickoffState edge — guarantees the anchor CTA
  // stays visible until the user acts on it.
  const handleDeployTeamCompleted = useCallback(() => {
    setShowKickoffSummary(true);
    void meReload();
  }, [meReload]);

  const handleDeployTeamReset = useCallback(() => {
    void meReload();
  }, [meReload]);

  const handleEnterOffice = useCallback(() => {
    setShowKickoffSummary(false);
    const cid = me.company?.id;
    if (cid) {
      markKickoffResolved(cid);
      setKickoffResolved(true);
    }
  }, [me.company?.id]);

  const handleAnchorSkip = useCallback(() => {
    const cid = me.company?.id;
    if (!cid) return;
    markKickoffAnchorSkipped(cid);
    setAnchorSkipped(true);
    // Also flip summary on so the user sees the "Enter your office"
    // CTA. handleDeployTeamCompleted (called by KickoffWindow on skip)
    // sets it too — duplicate set is a no-op.
    setShowKickoffSummary(true);
  }, [me.company?.id]);

  const handleAnchorResumeFromBanner = useCallback(() => {
    const cid = me.company?.id;
    if (!cid) return;
    clearKickoffAnchorSkip(cid);
    setAnchorSkipped(false);
    // Also drop the "resolved" sentinel so phase derivation can flip
    // back to "deploying-team". Without this, the gate added below
    // (!kickoffResolved) would keep the user in `live` and the banner
    // click would be a no-op.
    clearKickoffResolved(cid);
    setKickoffResolved(false);
  }, [me.company?.id]);

  // Auto-clear the skip flag once every non-CEO agent is actually
  // anchored on chain. Without this, the localStorage entry would
  // linger forever and confuse a future kickoff (e.g. user adds more
  // hires later in Phase 2).
  const needsKickoffAnchor = useMemo(
    () =>
      me.agents.some(
        (a) => a.role !== CEO_ROLE && a.agentChainTxSignature === null,
      ),
    [me.agents],
  );
  useEffect(() => {
    if (needsKickoffAnchor) return;
    const cid = me.company?.id;
    if (!cid) return;
    if (!isKickoffAnchorSkipped(cid)) return;
    clearKickoffAnchorSkip(cid);
    setAnchorSkipped(false);
  }, [needsKickoffAnchor, me.company?.id]);

  // ── Phase derivation ─────────────────────────────────────────────────────
  // Order matters: cinematic walkStage takes precedence over data-driven
  // kickoff branches so a user mid-intro doesn't get yanked into
  // kickoff-form by an out-of-band useMe refetch.
  const phase: SetupPhase = useMemo(() => {
    if (!authenticated) return "idle";
    const onboardingKind = onboarding.status.kind;
    if (onboardingKind === "loading") return "idle";
    if (onboardingKind === "needed") return "onboarding-form";
    if (onboardingKind === "recovery-needed") return "recovery-pair-gateway";
    if (onboardingKind === "submitting" || onboardingKind === "error") {
      return "provisioning-ceo";
    }
    if (onboardingKind === "anchoring" || onboardingKind === "anchor-error") {
      return "anchoring-ceo";
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
    if (kickoffState === "provisioning") return "deploying-team";
    if (kickoffState === "completed") {
      // After server kickoff completes, the on-chain anchor for the
      // hires is still a pending FE action. Hold the user in
      // `deploying-team` (KickoffWindow + AnchorPanel) until every
      // non-CEO agent has confirmed deployment on chain — UNLESS:
      //   • the user has explicitly skipped (anchorSkipped), or
      //   • the kickoff phase was already resolved once (kickoffResolved)
      //     — i.e. user has been on the live OS at least once since
      //     kickoff completed. After that, ad-hoc agent deploys handle
      //     their own anchor flow inline; un-anchored agents are surfaced
      //     by AnchorReminderBanner, NOT by re-opening KickoffWindow.
      //
      // `agentChainTxSignature` (only set on confirm) is the reliable
      // "actually broadcast" signal — `agentPda` mirrors identity_pda
      // which gets pre-written by the prepare route.
      if (needsKickoffAnchor && !anchorSkipped && !kickoffResolved) {
        return "deploying-team";
      }
      return showKickoffSummary ? "kickoff-complete" : "live";
    }
    return "idle";
  }, [
    authenticated,
    onboarding.status.kind,
    walkStage,
    introCompleted,
    me.company,
    needsKickoffAnchor,
    anchorSkipped,
    kickoffResolved,
    showKickoffSummary,
  ]);

  // Auto-heal for users who passed kickoff before the kickoffResolved
  // flag existed. We can't gate on `phase === "live"` here — an existing
  // user who deploys an ad-hoc agent post-kickoff lands on phase
  // "deploying-team" the moment they refresh (because Atlas is unanchored
  // and the storage flag is missing), so the live branch never runs.
  //
  // Signal we trust instead: at least one non-CEO agent already has a
  // confirmed on-chain signature. The KickoffWindow batch flow signs the
  // whole cohort in one wallet popup — partial-success states only exist
  // mid-anchor (which would have a wallet popup open, not a refresh), so
  // "≥1 anchored non-CEO" reliably means "kickoff was resolved before".
  useEffect(() => {
    const cid = me.company?.id;
    if (!cid) return;
    if (kickoffResolved) return;
    const hasAnchoredAgent = me.agents.some(
      (a) => a.role !== CEO_ROLE && a.agentChainTxSignature !== null,
    );
    if (!hasAnchoredAgent) return;
    markKickoffResolved(cid);
    setKickoffResolved(true);
  }, [me.agents, me.company?.id, kickoffResolved]);

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
      phase === "deploying-team" ||
      phase === "kickoff-complete"
    ) {
      return "meeting";
    }
    return null;
  }, [phase]);

  const onboardingActive =
    phase === "onboarding-form" ||
    phase === "recovery-pair-gateway" ||
    phase === "provisioning-ceo" ||
    phase === "anchoring-ceo" ||
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
    handleDeployTeamCompleted,
    handleDeployTeamReset,
    handleAnchorSkip,
    handleAnchorResumeFromBanner,
    showAnchorReminder:
      needsKickoffAnchor && anchorSkipped && !anchorBannerDismissed,
    handleDismissAnchorBanner,
    handleEnterOffice,
  };
}
