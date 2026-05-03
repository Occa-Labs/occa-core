"use client";

import { useEffect, useRef } from "react";

// Tracks cursor position relative to the host element's center and writes
// two CSS custom properties on it:
//   --spotlight-angle    — degrees (-180..180), atan2 of cursor offset
//   --spotlight-distance — pixels from element center, clamped to a max
// The CSS-side rule (`.glass-spotlight::after`) reads these to draw a
// gradient highlight on the inner border that "tracks" the cursor as it
// moves across the page. rAF-throttled so 60Hz mousemove events don't
// stampede the style writes.
//
// Usage:
//   const ref = useCursorSpotlight<HTMLDivElement>();
//   return <div ref={ref} className="glass-spotlight">…</div>;
//
// Pass `false` to disable cleanly while keeping the same ref shape — useful
// for components that conditionally enable the effect via a boolean prop.

export function useCursorSpotlight<
  T extends HTMLElement = HTMLElement,
>(enabled: boolean = true) {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;

    let raf: number | null = null;
    let pendingX = 0;
    let pendingY = 0;

    const flush = () => {
      raf = null;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = pendingX - cx;
      const dy = pendingY - cy;
      // 0deg points right; reference CSS rotates by `1deg * angle`, so
      // any 360 range is fine. Using radians-to-degrees for parity with
      // the reference snippet.
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);
      const distance = Math.min(Math.hypot(dx, dy), 2000);
      el.style.setProperty("--spotlight-angle", String(angle.toFixed(1)));
      el.style.setProperty("--spotlight-distance", String(distance.toFixed(0)));
    };

    const onMove = (e: MouseEvent) => {
      pendingX = e.clientX;
      pendingY = e.clientY;
      if (raf == null) raf = requestAnimationFrame(flush);
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [enabled]);

  return ref;
}
