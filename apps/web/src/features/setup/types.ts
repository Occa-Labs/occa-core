// Unified phase enum covering the entire first-run arc — onboarding +
// CEO intro animation + kickoff + team hiring + live OS. Single source of
// truth: `useSetupWorkflow` derives this from useAuth + useOnboarding +
// useMe + a small local sub-state for the post-onboarding cinematic.
//
// Each phase corresponds 1:1 with what `<SetupWorkflow>` renders:
//   idle             — nothing (auth still hydrating or me still loading)
//   onboarding-form  — <OnboardingFormDialog>
//   provisioning-ceo — <SetupProgressDialog>
//   anchoring-ceo    — <AnchorIdentityDialog>  (Phase B — on-chain anchor)
//   ceo-ready        — <CeoReadyDialog>      (Jia at the door)
//   walking          — nothing visible; OfficeScene runs the walk
//   ceo-intro        — <CeoIntroDialog>      (Jia + CEO scripted intro)
//   kickoff-form     — <KickoffDialog>
//   hiring           — <HiringWindow>
//   kickoff-complete — <KickoffSummaryDialog> (review + retry failed)
//   live             — nothing; <OsShell> takes over
export type SetupPhase =
  | "idle"
  | "onboarding-form"
  | "provisioning-ceo"
  | "anchoring-ceo"
  | "ceo-ready"
  | "walking"
  | "ceo-intro"
  | "kickoff-form"
  | "hiring"
  | "kickoff-complete"
  | "live";
