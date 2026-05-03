/**
 * OCCA OS design tokens — single source of truth for surface styles.
 *
 * All major chrome (dock, windows, modals, panels, tooltips) pulls from here
 * so the background, blur, and border stay visually consistent.
 *
 * Usage (inline style):
 *   style={{ ...surface.base, ...surface.shadow.sm }}
 */

// ── Base palette ──────────────────────────────────────────────────────────────

/** Core surface color: dark neutral tinted slightly cool. */
const BG_BASE = "rgba(18, 18, 22, 0.78)";
/** Elevated surface — modals, popovers sit one step lighter. */
const BG_ELEVATED = "rgba(26, 26, 32, 0.88)";
/** Recessed surface — inner panels, sidebars. */
const BG_RECESSED = "rgba(12, 12, 16, 0.65)";

const BLUR_STD = "blur(24px) saturate(1.6)";
const BLUR_HEAVY = "blur(60px) saturate(1.8) brightness(1.06)";

const BORDER_STD = "1px solid rgba(255, 255, 255, 0.09)";
const BORDER_SUBTLE = "1px solid rgba(255, 255, 255, 0.06)";

// ── Surface presets ───────────────────────────────────────────────────────────

export type SurfaceStyle = React.CSSProperties;

export const surface = {
  /** Dock, windows, sheets — the main chrome layer. */
  base: {
    background: BG_BASE,
    backdropFilter: BLUR_STD,
    WebkitBackdropFilter: BLUR_STD,
    border: BORDER_STD,
  } satisfies SurfaceStyle,

  /** Modals, popovers — float above the base layer. */
  elevated: {
    background: BG_ELEVATED,
    backdropFilter: BLUR_HEAVY,
    WebkitBackdropFilter: BLUR_HEAVY,
    border: BORDER_STD,
  } satisfies SurfaceStyle,

  /** Inner panels, sidebars — sit below the base layer. */
  recessed: {
    background: BG_RECESSED,
    backdropFilter: BLUR_STD,
    WebkitBackdropFilter: BLUR_STD,
    border: BORDER_SUBTLE,
  } satisfies SurfaceStyle,
} as const;

// ── Border token (standalone) ─────────────────────────────────────────────────

export const border = {
  std: BORDER_STD,
  subtle: BORDER_SUBTLE,
  /** Dividers inside surfaces. */
  divider: "1px solid rgba(255, 255, 255, 0.065)",
} as const;

// ── Shadow presets ────────────────────────────────────────────────────────────

export const shadow = {
  sm: "none",
  md: "none",
  lg: "none",
} as const;

// ── Specular top-edge highlight (Tahoe signature) ─────────────────────────────

/** Paste this as a `<div>` with `className="absolute inset-x-0 top-0 h-px pointer-events-none"`. */
export const specularStyle: React.CSSProperties = {
  background:
    "linear-gradient(90deg, transparent 5%, rgba(255,255,255,0.16) 30%, rgba(255,255,255,0.20) 50%, rgba(255,255,255,0.16) 70%, transparent 95%)",
};
