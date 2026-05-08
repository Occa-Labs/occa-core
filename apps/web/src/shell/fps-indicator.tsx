"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// Frame-rate gauge driven by rAF. Sampling runs every animation frame for
// accuracy, but state (and therefore React re-render) only updates twice
// a second — high enough to feel live, low enough that the indicator
// itself isn't a meaningful FPS cost.
const SAMPLE_WINDOW_MS = 500;

function fpsColour(fps: number): string {
  if (fps >= 55) return "text-emerald-400";
  if (fps >= 40) return "text-amber-400";
  return "text-red-400";
}

interface FpsIndicatorProps {
  className?: string;
  /** When true, render as an inline cell (no glass surface, no fixed
   *  positioning) for embedding inside a parent menu bar. */
  embedded?: boolean;
}

export function FpsIndicator({ className, embedded = false }: FpsIndicatorProps) {
  const [fps, setFps] = useState<number | null>(null);
  const framesRef    = useRef(0);
  const lastFlushRef = useRef(0);

  useEffect(() => {
    let raf = 0;
    const tick = (t: number) => {
      framesRef.current++;
      if (lastFlushRef.current === 0) lastFlushRef.current = t;
      const elapsed = t - lastFlushRef.current;
      if (elapsed >= SAMPLE_WINDOW_MS) {
        setFps((framesRef.current * 1000) / elapsed);
        framesRef.current    = 0;
        lastFlushRef.current = t;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const text = (
    <span
      className={cn(
        "font-mono text-[11px] font-light tabular-nums",
        fps == null ? "text-white/40" : fpsColour(fps),
      )}
    >
      {fps == null ? "–" : Math.round(fps)} FPS
    </span>
  );

  if (embedded) {
    return (
      <div className={cn("inline-flex items-center", className)} title="Frames per second">
        {text}
      </div>
    );
  }

  return (
    <div
      className={cn("fixed right-4 top-4 z-50 glass-heavy rounded-xl px-3 py-2", className)}
      title="Frames per second"
    >
      {text}
    </div>
  );
}
