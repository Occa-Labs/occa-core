// Centralized TanStack Query configuration. One QueryClient per app.
// Per-feature query hooks (in `features/<name>/api/`) inherit these
// defaults; only override per-query when a specific query needs different
// staleness / refetch behavior.

import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api-client";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Most data is fine to consider fresh for 30s; specific hooks
        // override for fast-changing surfaces (live agent state, traces).
        staleTime: 30_000,
        // Window focus refetch helps when the tab has been backgrounded.
        refetchOnWindowFocus: true,
        // Auto-retry only network/5xx errors, never 4xx (won't succeed).
        retry: (failureCount, error) => {
          if (failureCount >= 2) return false;
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            return false;
          }
          return true;
        },
        retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 30_000),
      },
      mutations: {
        // Mutations don't auto-retry — caller decides via `onError`.
        retry: false,
      },
    },
  });
}
