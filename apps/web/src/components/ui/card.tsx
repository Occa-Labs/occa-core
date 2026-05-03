"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { surface, border as borderTokens } from "@/components/ui/tokens";
import { useCursorSpotlight } from "@/hooks/use-cursor-spotlight";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CardVariant = "base" | "recessed" | "elevated";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  /** Makes the card respond to hover with a subtle brightness lift. */
  interactive?: boolean;
  /** Padding preset. Default: "md". */
  padding?: "none" | "sm" | "md" | "lg";
  /**
   * Replaces the variant's surface treatment with the Vision-OS-style
   * "spotlight" glass: white-tinted frosted backdrop, inset rim, and a
   * 1px gradient inner-border that follows the cursor. Used by hero /
   * onboarding panels that sit over the 3D office and need stronger
   * presence than the base window chrome. The cursor-tracking effect is
   * opt-in via this prop so regular cards stay cheap (no global mousemove
   * listener).
   *
   * Important: callers should NOT pass `transform` or `opacity` via the
   * `style` prop on a spotlight card — both promote the element to its
   * own composited layer, which causes `backdrop-filter` to sample from
   * an empty layer instead of the real page output behind. Use class-
   * based animations (animate-in, etc) or don't animate at all.
   */
  spotlight?: boolean;
  children?: ReactNode;
}

// ── Config ────────────────────────────────────────────────────────────────────

const variantStyle: Record<CardVariant, React.CSSProperties> = {
  base: surface.base,
  recessed: surface.recessed,
  elevated: surface.elevated,
};

const paddingClass: Record<"none" | "sm" | "md" | "lg", string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-5",
};

// ── Component ─────────────────────────────────────────────────────────────────

export function Card({
  variant = "recessed",
  interactive = false,
  padding = "md",
  spotlight = false,
  className = "",
  style,
  children,
  ...props
}: CardProps) {
  // Always create the ref (React rules-of-hooks). The hook itself no-ops
  // when `enabled` is false, so non-spotlight cards pay zero runtime cost.
  const spotlightRef = useCursorSpotlight<HTMLDivElement>(spotlight);

  if (spotlight) {
    // Inline style for the heavy lifting (bg tint + backdrop-filter +
    // shadow rim) — same pattern as `surface.recessed` on the non-spotlight
    // branch, which is verified to work. Inline styles win every Tailwind
    // v4 utility-cascade tie, so backdrop-filter never gets clobbered by
    // an empty `backdrop-filter` rule from the base layer.
    //
    // The `glass-spotlight` class is kept ONLY to attach the ::after
    // pseudo (cursor-tracked gradient rim — pseudo-elements can't be
    // applied via inline style).
    //
    // No `overflow-hidden` so callers can overhang chips past the top
    // edge (SpeakerBadge etc).
    return (
      <div
        ref={spotlightRef}
        className={`
          glass-spotlight rounded-2xl
          ${paddingClass[padding]}
          ${interactive ? "cursor-pointer transition-[filter] duration-150 hover:brightness-110 active:brightness-95" : ""}
          ${className}
        `}
        style={{
          position: "relative",
          // Dark-mode glass — same family as AppWindow chrome
          // (surface.elevated). Keeps the cursor-tracked rim animation
          // while sitting in the same tonal range as the OS windows so
          // dialogs don't pop as a brighter sheet over the 3D office.
          backgroundColor: "rgba(20, 20, 24, 0.82)",
          backdropFilter: "blur(40px) saturate(1.6)",
          WebkitBackdropFilter: "blur(40px) saturate(1.6)",
          boxShadow:
            "inset 0 0 0 1px rgba(255,255,255,0.10)," +
            "inset 0 1px 0 0 rgba(255,255,255,0.16),",
          ...style,
        }}
        {...props}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      className={`
        rounded-2xl overflow-hidden
        ${paddingClass[padding]}
        ${interactive ? "cursor-pointer transition-all hover:brightness-110 active:brightness-95" : ""}
        ${className}
      `}
      style={{
        ...variantStyle[variant],
        border: borderTokens.std,
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  );
}

// ── Divider ───────────────────────────────────────────────────────────────────

/** A horizontal rule that matches the card border colour. */
export function CardDivider({ className = "" }: { className?: string }) {
  return (
    <div
      className={`w-full h-px ${className}`}
      style={{ background: "rgba(255,255,255,0.065)" }}
    />
  );
}
