"use client";

// Onboarding step 2 — pair the OpenClaw gateway. Probe validates
// connectivity AND persists the device keypair to users.pendingDeviceKeypair
// so the final step's atomic deploy reuses the pairing.
//
// Inline help, lifted from the archived setup flow:
//   • "Where to find URL?" pill above the URL input — opens a
//     FloatingPanel with URL format + common setups + non-localhost
//     config snippet.
//   • "Where to find token?" pill above the bearer-token input — opens
//     a panel pointing at `~/.openclaw/openclaw.json`.
//   • When the probe returns `device_pairing_required`, a dedicated
//     pairing panel is shown alongside an "I've approved — retry"
//     button so the user can re-run the probe after approving on the
//     gateway host.

import { useState } from "react";
import { CheckCircle2, Info, Link2, Loader2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { useProbeGateway } from "../api/use-probe-gateway";
import {
  ApiKeyHelp,
  DevicePairingHelp,
  GatewayUrlHelp,
} from "./help-content";

type HelpKey = "url" | "key" | "pairing";

interface StepGatewayProps {
  gatewayUrl: string;
  apiKey: string;
  onGatewayUrlChange: (next: string) => void;
  onApiKeyChange: (next: string) => void;
  onContinue: () => void;
  onBack: () => void;
}

export function StepGateway({
  gatewayUrl,
  apiKey,
  onGatewayUrlChange,
  onApiKeyChange,
  onContinue,
  onBack,
}: StepGatewayProps) {
  const probe = useProbeGateway();
  const [helpKey, setHelpKey] = useState<HelpKey | null>(null);
  const [helpRect, setHelpRect] = useState<DOMRect | null>(null);

  const trimmedUrl = gatewayUrl.trim();
  const trimmedKey = apiKey.trim();
  const canSubmit =
    trimmedUrl.length > 0 && trimmedKey.length > 0 && !probe.isPending;

  const runProbe = async () => {
    if (!canSubmit) return;
    try {
      const result = await probe.mutateAsync({
        gatewayUrl: trimmedUrl,
        apiKey: trimmedKey,
      });
      if (result.ok) onContinue();
    } catch {
      /* error surfaced inline below */
    }
  };

  const openHelp = (key: HelpKey, evt: React.MouseEvent<HTMLButtonElement>) => {
    evt.stopPropagation();
    setHelpRect(evt.currentTarget.getBoundingClientRect());
    setHelpKey(key);
  };

  const probeErrorCode = (() => {
    if (probe.isError) {
      const err = probe.error;
      if (err instanceof ApiError) return `api_${err.status}`;
      return err instanceof Error ? err.message : "probe_failed";
    }
    if (probe.data && !probe.data.ok) {
      return probe.data.error ?? "probe_failed";
    }
    return null;
  })();
  const pairingRequired = probeErrorCode === "device_pairing_required";

  return (
    <>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void runProbe();
        }}
      >
        <div className="flex items-start gap-2.5">
          <Link2 className="size-4 shrink-0 text-white/45 mt-0.5" />
          <div className="flex-1">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-[13px] font-semibold text-white/90">
                Pair your OpenClaw gateway
              </h2>
              <HelpPill
                label="How does pairing work?"
                onClick={(e) => openHelp("pairing", e)}
              />
            </div>
            <p className="mt-1 text-[11px] text-white/45 leading-relaxed">
              Agents talk to OpenClaw to run their workspaces. Paste your
              gateway URL + bearer token; we&apos;ll probe the connection
              and remember the pairing for the deploy in the next step.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-white/40">
              Gateway URL
            </span>
            <HelpPill
              label="Where to find URL?"
              onClick={(e) => openHelp("url", e)}
            />
          </div>
          <input
            type="text"
            value={gatewayUrl}
            onChange={(e) => onGatewayUrlChange(e.target.value)}
            placeholder="wss://gateway.example.com"
            className="rounded-md border border-white/10 bg-white/5 px-3 py-2 font-mono text-[12px] text-white placeholder:text-white/30 focus:border-white/25 focus:outline-none"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-white/40">
              Auth bearer token
            </span>
            <HelpPill
              label="Where to find token?"
              onClick={(e) => openHelp("key", e)}
            />
          </div>
          <input
            type="password"
            autoFocus
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder="—"
            autoComplete="off"
            className="rounded-md border border-white/10 bg-white/5 px-3 py-2 font-mono text-[12px] text-white placeholder:text-white/30 focus:border-white/25 focus:outline-none"
          />
        </div>

        {pairingRequired && (
          <div className="rounded-md border border-amber-400/25 bg-amber-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-amber-200/85">
            <p className="font-medium">Approve the pairing on OpenClaw.</p>
            <p className="mt-0.5 text-amber-200/65">
              The gateway has a pending operator approval request for this
              device. Approve it, then click <em>I&apos;ve approved</em>.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={(e) => openHelp("pairing", e)}
                className="flex cursor-pointer items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-100 transition-colors hover:bg-amber-500/20"
              >
                <Info className="size-3" />
                How to approve?
              </button>
              <button
                type="button"
                onClick={() => void runProbe()}
                disabled={probe.isPending}
                className="cursor-pointer rounded-md bg-amber-400/15 px-2.5 py-1 text-[11px] font-medium text-amber-100 transition-colors hover:bg-amber-400/25 disabled:opacity-50"
              >
                {probe.isPending ? "Retrying…" : "I've approved — retry"}
              </button>
            </div>
          </div>
        )}

        {!pairingRequired && probeErrorCode && (
          <p className="text-[11px] text-red-300/80">
            {prettifyProbeError(probeErrorCode)}
          </p>
        )}

        {probe.data && probe.data.ok && (
          <p className="flex items-center gap-1.5 text-[11px] text-emerald-300/80">
            <CheckCircle2 className="size-3.5" />
            Connected
            {probe.data.latencyMs != null
              ? ` (${Math.round(probe.data.latencyMs)} ms)`
              : ""}
          </p>
        )}

        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            onClick={onBack}
            disabled={probe.isPending}
            className="cursor-pointer rounded-md px-2.5 py-1.5 text-[12px] text-white/55 transition-colors hover:bg-white/6 hover:text-white/85 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Back
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="flex cursor-pointer items-center gap-1.5 rounded-md bg-sky-500/20 px-3 py-1.5 text-[12px] font-medium text-sky-100 transition-colors hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {probe.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="size-3.5" />
            )}
            Connect &amp; continue
          </button>
        </div>
      </form>

      {helpKey && (
        <FloatingPanel
          title={titleForHelp(helpKey)}
          subtitle={subtitleForHelp(helpKey)}
          width={460}
          zIndex={150}
          triggerRect={helpRect}
          onClose={() => setHelpKey(null)}
        >
          {helpKey === "url" && <GatewayUrlHelp />}
          {helpKey === "key" && <ApiKeyHelp />}
          {helpKey === "pairing" && <DevicePairingHelp />}
        </FloatingPanel>
      )}
    </>
  );
}

function HelpPill({
  label,
  onClick,
}: {
  label: string;
  onClick: (evt: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex cursor-pointer items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-white/55 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white/85"
    >
      <Info className="size-2.5" />
      {label}
    </button>
  );
}

function titleForHelp(key: HelpKey): string {
  if (key === "url") return "Where to find the gateway URL";
  if (key === "key") return "Where to find the bearer token";
  return "Approve device pairing";
}

function subtitleForHelp(key: HelpKey): string | undefined {
  if (key === "pairing") return "One-time setup";
  return undefined;
}

function prettifyProbeError(code: string): string {
  switch (code) {
    case "unreachable":
      return "Could not reach the gateway — check the URL and try again.";
    case "gateway_unauthorized":
      return "The gateway rejected the bearer token.";
    case "invalid_response":
      return "Gateway returned an unexpected response.";
    case "probe_failed":
      return "Probe failed. Try again or check the credentials.";
    default:
      return `Probe failed (${code}).`;
  }
}
