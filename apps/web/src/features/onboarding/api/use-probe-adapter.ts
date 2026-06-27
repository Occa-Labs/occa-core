"use client";

// Mutation hook for onboarding step 2 — probes the chosen adapter.
//
// Dispatched on adapter type:
//   • openclaw → POST /api/adapters/openclaw/probe. The server also
//     persists the device keypair + gateway-issued device token onto
//     users.pendingDeviceKeypair so the final-step deploy reuses the
//     pairing.
//   • hermes   → POST /api/adapters/hermes/probe. No server-side state
//     is persisted — Hermes uses the operator's on-disk SSH key as the
//     identity, not a paired device.

import { useMutation } from "@tanstack/react-query";
import { adaptersApi } from "@/lib/api";
import type {
  HermesProbeRequest,
  ProbeRequest,
  ProbeResponse,
} from "@occa/shared/types";

export type ProbeAdapterInput =
  | { type: "openclaw"; input: ProbeRequest }
  | { type: "hermes"; input: HermesProbeRequest }
  | {
      type: "claude-code";
      // Gateway-only (BYORT) — the gateway URL + bearer are required.
      input: { model?: string; gatewayUrl: string; apiKey: string };
    }
  | {
      type: "codex";
      // Gateway-only (BYORT) — the gateway URL + bearer are required.
      input: { model?: string; gatewayUrl: string; apiKey: string };
    };

export function useProbeAdapter() {
  return useMutation({
    mutationFn: (variables: ProbeAdapterInput): Promise<ProbeResponse> =>
      variables.type === "openclaw"
        ? adaptersApi.probeOpenclaw(variables.input)
        : variables.type === "hermes"
          ? adaptersApi.probeHermes(variables.input)
          : variables.type === "claude-code"
            ? adaptersApi.probeClaudeCode(variables.input)
            : adaptersApi.probeCodex(variables.input),
  });
}
