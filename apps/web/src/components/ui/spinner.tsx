"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// ASCII / Unicode character spinners. Each variant is a frame array; the
// component cycles through frames at `speed` ms per step. Variants are
// picked by name so call sites stay terse.
const FRAMES: Record<string, string[]> = {
  // Braille spinner — terminal classic, smooth rotation.
  // dots: "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".split(""),
  // Heavier braille block, feels more like a "loading" pulse.
  block: "⣾⣽⣻⢿⡿⣟⣯⣷".split(""),
  // Line slash, very old-school.
  // line: ["|", "/", "-", "\\"],
  // Quarter-arc rotation, minimal + clean.
  // arc: ["◜", "◝", "◞", "◟"],
  // Single dot bouncing through 4 corners.
  // bounce: ["⠁", "⠂", "⠄", "⠂"],
  // Bar density pulse — feels like a heartbeat.
  pulse: ["█", "▓", "▒", "░", " ", "░", "▒", "▓"],
  // Box-drawing rotation.
  box: ["┤", "┘", "┴", "└", "├", "┌", "┬", "┐"],
  // Arrow compass.
  arrow: ["↖", "↑", "↗", "→", "↘", "↓", "↙", "←"],
  // Star spinner.
  // star: ["+", "x", "*", "X"],
  // Binary flicker — niche but on-brand for a dev tool.
  // binary: ["0", "1"],
  // Triangle rotation.
  // triangle: ["◢", "◣", "◤", "◥"],
};

export type SpinnerVariant = keyof typeof FRAMES;

export const SPINNER_VARIANTS: SpinnerVariant[] = Object.keys(
  FRAMES,
) as SpinnerVariant[];

interface SpinnerProps {
  className?: string;
  /** Frame set to cycle through. Omit to pick a random variant per-mount
   *  (so different loads feel a little different). */
  variant?: SpinnerVariant;
  /** Milliseconds per frame. Default 120ms (~8 fps) — fast enough to read
   *  as motion, slow enough that the per-frame React re-render isn't a
   *  perf concern when several spinners are mounted at once. */
  speed?: number;
}

function pickRandomVariant(): SpinnerVariant {
  return SPINNER_VARIANTS[Math.floor(Math.random() * SPINNER_VARIANTS.length)];
}

export function Spinner({ className, variant, speed = 120 }: SpinnerProps) {
  // Lock in a randomly chosen variant on first render. Re-rolling on every
  // render would flicker between variants every state update.
  const [resolvedVariant] = useState<SpinnerVariant>(
    () => variant ?? pickRandomVariant(),
  );
  const frames = FRAMES[resolvedVariant];
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % frames.length), speed);
    return () => clearInterval(t);
  }, [frames.length, speed]);
  return (
    <span
      className={cn(
        "inline-block font-mono text-2xl leading-none text-white/60",
        className,
      )}
      aria-label="Loading"
      role="status"
    >
      {frames[i]}
    </span>
  );
}
