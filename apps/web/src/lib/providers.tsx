"use client";

import { useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import {
  AuthProvider,
  DisabledAuthProvider,
} from "@/features/auth/hooks/use-auth";
import {
  AppPrivyProvider,
  PRIVY_ENABLED,
} from "@/features/auth/providers/privy-provider";
import { createQueryClient } from "./query-client";

export function AppProviders({ children }: { children: ReactNode }) {
  const [client] = useState(() => createQueryClient());
  return (
    <QueryClientProvider client={client}>
      {PRIVY_ENABLED ? (
        <AppPrivyProvider>
          <AuthProvider>{children}</AuthProvider>
        </AppPrivyProvider>
      ) : (
        // No Privy app id (e.g. fresh open-source clone) — render without
        // Privy so the app boots and /demo works; sign-in shows a notice.
        <DisabledAuthProvider>{children}</DisabledAuthProvider>
      )}
      {process.env.NODE_ENV === "development" && (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
      )}
    </QueryClientProvider>
  );
}
