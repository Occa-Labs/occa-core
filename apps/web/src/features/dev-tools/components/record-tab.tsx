"use client";

import { Disc, StopCircle } from "lucide-react";

interface RecordTabProps {
  active: boolean;
  onToggle?: () => void;
}

// Walk-path recorder controls. Toggle drives `devWalkRecord` upstream;
// when active, OfficeScene mounts the WaypointRecorder + on-screen HUD,
// and stopping emits the recorded path through the modal.

export function RecordTab({ active, onToggle }: RecordTabProps) {
  return (
    <div className="flex flex-col gap-3 p-4 text-xs">
      <header className="border-b border-white/10 pb-2">
        <h3 className="text-sm font-semibold text-white">Walk Path Recorder</h3>
        <p className="mt-1 text-[11px] text-white/50">
          Drive Jia around the office to capture a waypoint path. Used
          for the room-tour cinematic and Jia&apos;s onboarding walk.
        </p>
      </header>

      <section className="rounded-md border border-white/10 bg-white/5 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-white">
              {active ? "Recording in progress" : "Idle"}
            </div>
            <div className="text-[11px] text-white/50">
              {active
                ? "Use Arrow keys to walk Jia. Click Stop to capture the path — a modal will pop up with code to copy."
                : "Click Start to spawn Jia at her usual position and take control with Arrow keys."}
            </div>
          </div>
          <button
            onClick={onToggle}
            disabled={!onToggle}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] font-medium transition-colors ${
              active
                ? "bg-red-500 text-white hover:bg-red-400"
                : "bg-white/10 text-white hover:bg-white/20"
            } disabled:opacity-40`}
          >
            {active ? (
              <>
                <StopCircle className="size-3.5" />
                Stop Recording
              </>
            ) : (
              <>
                <Disc className="size-3.5" />
                Start Recording
              </>
            )}
          </button>
        </div>

        {active && (
          <div className="mt-3 rounded bg-black/30 p-2 text-[11px] text-white/70">
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex items-center gap-1.5">
                <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">↑</kbd>
                <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">↓</kbd>
                forward / back
              </span>
              <span className="flex items-center gap-1.5">
                <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">←</kbd>
                <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">→</kbd>
                turn
              </span>
              <span className="flex items-center gap-1.5">
                <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">SPACE</kbd>
                mark dialog
              </span>
            </div>
            <div className="mt-1.5 text-white/45">
              Path samples every 2 world-units while Jia is moving. Press
              <kbd className="mx-0.5 rounded bg-white/10 px-1 py-0.5 font-mono text-[10px]">SPACE</kbd>
              at any spot to insert a dialog placeholder Jia will narrate
              during playback.
            </div>
          </div>
        )}
      </section>

      <p className="text-[11px] text-white/35 leading-relaxed px-1">
        Paste the captured array into{" "}
        <code className="text-white/60">ROOM_TOUR_WAYPOINTS</code> in{" "}
        <code className="text-white/60">features/theater/constants.ts</code>{" "}
        to make it the active room-tour path, or into{" "}
        <code className="text-white/60">WALK_WAYPOINTS</code> to update
        Jia&apos;s onboarding route.
      </p>
    </div>
  );
}
