"use client";

import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { surface } from "@/components/ui/tokens";
import { DEMO_AGENTS } from "@/archive/demo/data";
import { INTRO_DIALOG } from "@/features/theater/constants";
import { LandingFab } from "@/features/auth/components/landing-fab";

// Production demo route. Public, no auth, no API calls. Renders only the
// 3D office scene populated from `DEMO_AGENTS` plus a single "Show Me
// Around" button that triggers Jia's room tour cinematic. Top menu and
// dock are intentionally omitted — production builds force-redirect every
// other path to `/demo` (see middleware.ts). Override with
// NEXT_PUBLIC_DEMO_MODE=0 in production for debugging.

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

export default function DemoPage() {
  const [tourActive, setTourActive] = useState(false);
  const [tourDialog, setTourDialog] = useState<string | null>(null);
  // Two-phase tour: intro line first (Jia stands, camera face-to-face),
  // then walking starts when the intro auto-dismisses. Tracked separately
  // from `tourDialog` so the walking phase can keep firing waypoint
  // dialogs without re-triggering the intro.
  const [tourWalkEnabled, setTourWalkEnabled] = useState(false);

  const handleStartTour = useCallback(() => {
    setTourActive(true);
    setTourWalkEnabled(false);
    setTourDialog(INTRO_DIALOG);
  }, []);
  const handleTourEnd = useCallback(() => {
    setTourActive(false);
    setTourWalkEnabled(false);
    setTourDialog(null);
  }, []);
  const handleTourDialog = useCallback((text: string) => {
    setTourDialog(text);
  }, []);
  const clearTourDialog = useCallback(() => {
    setTourDialog(null);
    // First dismiss = intro line finished → start walking. Subsequent
    // dismisses are waypoint lines and don't change the phase.
    setTourWalkEnabled(true);
  }, []);

  return (
    <main className="relative h-svh w-full overflow-hidden">
      <OfficeScene
        agents={DEMO_AGENTS}
        showRoof
        tourActive={tourActive}
        tourWalkEnabled={tourWalkEnabled}
        onTourEnd={handleTourEnd}
        tourDialog={tourDialog}
        onTourDialog={handleTourDialog}
        onTourDialogDismiss={clearTourDialog}
      />
      {!tourActive && (
        <button
          type="button"
          onClick={handleStartTour}
          className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 flex h-14 items-center rounded-full border-white/12 px-7 text-sm font-medium text-white/80 shadow-[0_14px_34px_rgba(0,0,0,0.22)] transition-all duration-200 hover:scale-[1.03] hover:text-white active:scale-95 select-none"
          style={surface.base}
        >
          Show Me Around
        </button>
      )}
      <LandingFab />
    </main>
  );
}
