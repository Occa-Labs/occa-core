"use client";

import { Sparkle } from "lucide-react";
import type { ReactNode } from "react";
import { surface } from "@/components/ui/tokens";
import { cn } from "@/lib/utils";

// Two visual flavours:
//   "narrator"  — neutral glass; used for Jia, the onboarding guide.
//   "agent"     — purple-tinted; used for spawned company agents (CTO, CMO, etc.).
// Bertambah variant kalau muncul "system" / "user" speaker yang butuh tone tersendiri.
export type SpeakerKind = "narrator" | "agent";

export interface SpeakerBadgeProps {
  name: ReactNode;
  kind?: SpeakerKind;
  className?: string;
}

const agentTint = {
  background: "rgba(109,40,217,0.32)",
  border: "1px solid rgba(167,139,250,0.45)",
  backdropFilter: "blur(28px) saturate(1.6)",
  WebkitBackdropFilter: "blur(28px) saturate(1.6)",
  // Forces its own stacking context so the blur samples the page output
  // even when an ancestor uses transform / filter.
  isolation: "isolate",
} as const;

const narratorTint = {
  ...surface.recessed,
  isolation: "isolate",
} as const;

export function SpeakerBadge({
  name,
  kind = "narrator",
  className,
}: SpeakerBadgeProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full",
        "px-3 py-1.25 text-[12px] font-medium leading-none",
        "text-white select-none",
        className,
      )}
      style={kind === "agent" ? agentTint : narratorTint}
    >
      <Sparkle
        className="size-3 shrink-0 fill-white text-white"
        strokeWidth={1.5}
      />
      <span className="leading-none">{name}</span>
    </div>
  );
}
