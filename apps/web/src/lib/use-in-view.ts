"use client";

import { useEffect, useRef } from "react";

/**
 * Infinite-scroll sentinel. Place the returned ref on a small div at the
 * bottom of a scroll container; `onInView` fires whenever it scrolls into
 * view. The callback is held in a ref so the observer isn't torn down on
 * every render — the effect only re-runs when `enabled` flips.
 */
export function useInView(onInView: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const callback = useRef(onInView);
  callback.current = onInView;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) callback.current();
      },
      { rootMargin: "120px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled]);

  return ref;
}
