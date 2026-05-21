"use client";

// Mutation hook for onboarding step 2 — POST /api/adapters/openclaw/probe.
// The probe call on the server side ALSO persists the device keypair +
// gateway-issued device token onto users.pendingDeviceKeypair, so a
// successful probe leaves the user ready to deploy a CEO later without
// re-pairing.

import { useMutation } from "@tanstack/react-query";
import { adaptersApi } from "@/lib/api";
import type { ProbeRequest } from "@occa/shared/types";

export function useProbeGateway() {
  return useMutation({
    mutationFn: (input: ProbeRequest) => adaptersApi.probeOpenclaw(input),
  });
}
