"use client";

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { SpeakerBadge } from "@/components/ui/speaker-badge";

interface TourDialogProps {
  /** Current line for Jia to narrate. Null = no dialog showing. Each
   *  non-null change re-runs the typewriter effect from scratch. */
  text: string | null;
  /** Fired once the line finishes typing AND its read-time hold has
   *  elapsed. The room-tour state machine resumes Jia's walk on this. */
  onDismiss: () => void;
}

// Typewriter speed (chars/sec). Matches CeoIntroDialog feel.
const TYPE_CHARS_PER_SEC = 32;
// Minimum time the line stays on screen *after* the typewriter finishes,
// so even very short lines get read. Plus a per-character read padding
// for longer lines so they don't dismiss before the user can finish.
const MIN_HOLD_MS = 50;
const PER_CHAR_HOLD_MS = 10;

// Auto-dismissing room-tour narration overlay. No buttons, no clicks —
// the line types in, holds for read time, then onDismiss fires and the
// tour resumes. Same bottom-sheet styling as the onboarding intro so
// the two cinematics feel like one product.

export function TourDialog({ text, onDismiss }: TourDialogProps) {
  const [displayed, setDisplayed] = useState("");
  const [typing, setTyping] = useState(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // Whenever a new line arrives, restart the typewriter and schedule
  // dismiss. Cleanup on unmount / new-text replaces handlers cleanly.
  useEffect(() => {
    if (!text) {
      setDisplayed("");
      setTyping(false);
      return;
    }
    setDisplayed("");
    setTyping(true);

    const total = text.length;
    const typeMs = (total / TYPE_CHARS_PER_SEC) * 1000;
    const holdMs = MIN_HOLD_MS + total * PER_CHAR_HOLD_MS;

    let frame = 0;
    const startedAt = performance.now();
    let raf = 0;

    const tick = () => {
      const elapsed = performance.now() - startedAt;
      const ratio = Math.min(1, elapsed / typeMs);
      const chars = Math.floor(ratio * total);
      if (chars !== frame) {
        frame = chars;
        setDisplayed(text.slice(0, chars));
      }
      if (ratio < 1) raf = requestAnimationFrame(tick);
      else {
        setDisplayed(text);
        setTyping(false);
      }
    };
    raf = requestAnimationFrame(tick);

    const dismissTimer = window.setTimeout(() => {
      onDismissRef.current();
    }, typeMs + holdMs);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(dismissTimer);
    };
  }, [text]);

  if (!text) return null;

  return (
    <div className="fixed inset-0 z-100 flex items-end justify-center pointer-events-none">
      <div
        className="absolute inset-0 transition-opacity duration-500"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.28) 100%)",
        }}
      />
      <div className="relative w-full max-w-2xl mx-4 mb-8">
        <Card
          spotlight
          padding="lg"
          className="relative animate-in fade-in duration-500"
        >
          <div className="absolute top-0 left-6 -translate-y-1/2 z-10">
            <SpeakerBadge name="Jia" kind="narrator" />
          </div>

          <div className="mt-2 min-h-12 flex items-start">
            <p className="text-sm text-white/90 leading-relaxed">
              {displayed}
              {typing && (
                <span className="inline-block w-0.5 h-4 bg-white/60 ml-0.5 animate-pulse align-middle" />
              )}
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
