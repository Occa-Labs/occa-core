"use client";

// Deploy-CEO state machine for the final onboarding step.
//
// Behaviour mirrors the archived `useOnboarding.launch` flow so the user
// sees a real progress story instead of a silent spinner during the
// 5-30s gateway provisioning window:
//
//   • Calls POST /api/agents (SSE) — server creates company + CEO row
//     atomically when `companyName` is set, then provisions the agent on
//     the OpenClaw gateway. Step events drive the displayed sub-stage.
//   • If a previous launch already created the row but provisioning
//     died, the caller passes `pendingAgentId` and we hit POST
//     /api/agents/:id/reprovision instead so the gateway isn't
//     duplicated on retry. `adapterConfig` is always re-sent — the
//     chain-recovery path needs fresh creds, and reusing them on a
//     normal retry is harmless because the server overwrites with the
//     same values.

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { agentsApi, ApiError } from "@/lib/api";
import { ME_QUERY_KEY } from "@/hooks/use-me";
import { CEO_ROLE } from "@occa/shared/role-catalog";
import type { CreateAgentRequest, OpenclawAdapterConfig } from "@occa/shared/types";

export type DeployStage =
  | "idle"
  | "creating-company"
  | "provisioning-agent"
  | "gateway-restarting"
  | "done"
  | "error";

export interface DeployCeoInput {
  ceoName: string;
  companyName: string;
  adapterConfig: OpenclawAdapterConfig;
  /** When set, retry an existing failed provision via the reprovision
   *  endpoint instead of creating a fresh row. */
  pendingAgentId: string | null;
}

export interface DeployCeoResult {
  stage: DeployStage;
  error: { message: string; reason?: string } | null;
  /** Agent id surfaced by a post-DB-commit failure. Caller passes this
   *  back as `pendingAgentId` on retry so the next attempt reprovisions
   *  the existing row instead of creating a duplicate. */
  pendingAgentId: string | null;
  run: (input: DeployCeoInput) => Promise<void>;
  reset: () => void;
}

// Switch to the "gateway-restarting" hint after this long stuck in the
// provisioning sub-stage. Matches the 3-5s quiet window during an
// OpenClaw restart so the hint appears before the user loses patience
// but doesn't flash for fast no-restart commits.
const RESTART_HINT_DELAY_MS = 4000;
const PROVISION_HINT_DELAY_MS = 800;

export function useDeployCeo(): DeployCeoResult {
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<DeployStage>("idle");
  const [error, setError] = useState<{ message: string; reason?: string } | null>(
    null,
  );
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const reset = useCallback(() => {
    setStage("idle");
    setError(null);
  }, []);

  const run = useCallback(
    async (input: DeployCeoInput) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setError(null);
      setStage("creating-company");

      // Time-based hints fire when the SSE goes briefly silent (typical
      // across the gateway restart window). Real `step` events overwrite
      // these immediately, so the hints are just floor-rate signal.
      const provisionHint = setTimeout(() => {
        setStage((s) => (s === "creating-company" ? "provisioning-agent" : s));
      }, PROVISION_HINT_DELAY_MS);
      const restartHint = setTimeout(() => {
        setStage((s) =>
          s === "creating-company" || s === "provisioning-agent"
            ? "gateway-restarting"
            : s,
        );
      }, RESTART_HINT_DELAY_MS);

      const onStep = (evt: { status: "running" | "done"; step: string }) => {
        if (evt.status !== "running") return;
        if (evt.step === "creating_record") setStage("creating-company");
        else if (evt.step === "provisioning") setStage("provisioning-agent");
        else if (evt.step === "gateway_restart") setStage("gateway-restarting");
      };

      try {
        if (input.pendingAgentId) {
          await agentsApi.reprovisionStream(
            input.pendingAgentId,
            onStep,
            undefined,
            { adapterConfig: input.adapterConfig },
          );
        } else {
          const body: CreateAgentRequest = {
            name: input.ceoName,
            role: CEO_ROLE,
            adapterType: "openclaw",
            adapterConfig: input.adapterConfig,
            companyName: input.companyName,
          };
          await agentsApi.createStream(body, onStep);
        }
        setStage("done");
        setPendingAgentId(null);
        await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      } catch (err) {
        const parsed = parseLaunchError(err);
        if (parsed.agentId) setPendingAgentId(parsed.agentId);
        setError({ message: parsed.message, reason: parsed.reason });
        setStage("error");
      } finally {
        clearTimeout(provisionHint);
        clearTimeout(restartHint);
        inFlightRef.current = false;
      }
    },
    [queryClient],
  );

  return { stage, error, pendingAgentId, run, reset };
}

// Server fail() emits messages shaped like "outer: inner — reason text".
// Unwrap to the inner code so the UI can prettify it (and so retries can
// reuse the agent id from the error frame).
function parseLaunchError(err: unknown): {
  message: string;
  reason?: string;
  agentId?: string;
} {
  if (!(err instanceof ApiError)) {
    return {
      message: err instanceof Error ? err.message : "launch_failed",
    };
  }
  const body = err.body as
    | { error?: string; message?: string; reason?: string; agentId?: string }
    | undefined;
  let reason = body?.reason;
  const raw = (body?.error ?? body?.message ?? "").trim();
  let code = raw;
  if (code.includes(":")) {
    const afterColon = raw.split(":").slice(1).join(":").trim();
    const dashIdx = afterColon.indexOf("—");
    if (dashIdx > 0) {
      code = afterColon.slice(0, dashIdx).trim();
      if (!reason) reason = afterColon.slice(dashIdx + 1).trim();
    } else {
      code = afterColon;
    }
  }
  if (!code) {
    if (err.status === 409) code = "conflict";
    else if (err.status === 401) code = "gateway_unauthorized";
    else if (err.status === 502) code = "adapter_probe_failed";
    else if (err.status === 400) code = "invalid_body";
    else code = `api_${err.status}`;
  }
  return { message: code, reason, agentId: body?.agentId };
}
