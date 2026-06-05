"use client";

import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

/**
 * SSR-safe localStorage read. Returns `fallback` when the value is absent,
 * window is unavailable (server render), or the stored JSON is corrupt.
 */
export function readStored<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/**
 * SSR-safe localStorage write. Swallows quota-exceeded / private-mode errors
 * so a failed persist never breaks render.
 */
export function writeStored<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota exceeded / private mode — ignore */
  }
}

/** Remove a persisted key. SSR-safe and error-swallowing. */
export function clearStored(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* private mode — ignore */
  }
}

/**
 * `useState` backed by localStorage. Lazy-inits from storage on mount and
 * persists every change under `key`. Drop-in replacement for `useState` —
 * same `[value, setValue]` tuple, same setter semantics (value or updater fn).
 *
 * Values are JSON-serialized, so any serializable shape works (boolean,
 * string, object). On the server it renders `fallback`; the real stored value
 * hydrates on the client during the lazy init.
 */
export function usePersistentState<T>(
  key: string,
  fallback: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readStored(key, fallback));
  useEffect(() => {
    writeStored(key, value);
  }, [key, value]);
  return [value, setValue];
}
