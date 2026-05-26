"use client";

// Onboarding step 2 — pick the runtime adapter and supply its credentials.
//
// Two adapter cards sit at the top; the form below swaps to match the
// selected card. OpenClaw retains the original pairing + help-pill UX
// because its onboarding has more surface (gateway URL, bearer token,
// device pairing flow). Hermes mirrors OpenClaw exactly now that the
// transport is also HTTP + bearer (`hermes gateway` with API_SERVER_*),
// so the form fields collapse to gateway URL + bearer.
//
// State stays in the parent (`onboarding-window`) so switching cards back
// and forth doesn't wipe what's already typed.

import { useState } from "react";
import {
  CheckCircle2,
  Info,
  Loader2,
  Network,
  Server,
} from "lucide-react";
import { ApiError } from "@/lib/api";
import type { AdapterType } from "@occa/shared/types";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { useProbeAdapter } from "../api/use-probe-adapter";
import {
  ApiKeyHelp,
  DevicePairingHelp,
  GatewayUrlHelp,
} from "./help-content";

type HelpKey = "url" | "key" | "pairing" | "hermes-url" | "hermes-key";

interface StepRuntimeProps {
  adapterType: AdapterType;
  onAdapterTypeChange: (next: AdapterType) => void;
  // openclaw
  gatewayUrl: string;
  apiKey: string;
  onGatewayUrlChange: (next: string) => void;
  onApiKeyChange: (next: string) => void;
  // hermes
  hermesGatewayUrl: string;
  hermesApiKey: string;
  onHermesGatewayUrlChange: (next: string) => void;
  onHermesApiKeyChange: (next: string) => void;

  onContinue: () => void;
  onBack: () => void;
}

export function StepRuntime(props: StepRuntimeProps) {
  const {
    adapterType,
    onAdapterTypeChange,
    onContinue,
    onBack,
  } = props;
  const probe = useProbeAdapter();
  const [helpKey, setHelpKey] = useState<HelpKey | null>(null);
  const [helpRect, setHelpRect] = useState<DOMRect | null>(null);

  const canSubmit = !probe.isPending && isFormReady(props);

  const runProbe = async () => {
    if (!canSubmit) return;
    try {
      const result =
        adapterType === "openclaw"
          ? await probe.mutateAsync({
              type: "openclaw",
              input: {
                gatewayUrl: props.gatewayUrl.trim(),
                apiKey: props.apiKey.trim(),
              },
            })
          : await probe.mutateAsync({
              type: "hermes",
              input: {
                gatewayUrl: props.hermesGatewayUrl.trim(),
                apiKey: props.hermesApiKey.trim(),
              },
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

  const switchAdapter = (next: AdapterType) => {
    if (next === adapterType) return;
    probe.reset();
    onAdapterTypeChange(next);
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
  const pairingRequired =
    adapterType === "openclaw" && probeErrorCode === "device_pairing_required";

  return (
    <>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void runProbe();
        }}
      >
        <div className="space-y-2">
          <h2 className="text-[13px] font-semibold text-white/90">
            Pick a runtime
          </h2>
          <p className="text-[11px] text-white/45 leading-relaxed">
            OCCA stays in charge of memory and orchestration; the runtime is
            where your agent&apos;s loop actually runs. Pick the one you
            self-host today.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <AdapterCard
            active={adapterType === "openclaw"}
            icon={<Network className="size-4" />}
            label="OpenClaw"
            description="Self-hosted via OpenClaw gateway. WebSocket pairing, bearer token."
            onSelect={() => switchAdapter("openclaw")}
          />
          <AdapterCard
            active={adapterType === "hermes"}
            icon={<Server className="size-4" />}
            label="Hermes"
            description="Self-hosted Hermes Agent on your VPS. OpenAI-compatible HTTP gateway, bearer token."
            onSelect={() => switchAdapter("hermes")}
          />
        </div>

        {adapterType === "openclaw" ? (
          <OpenclawForm
            gatewayUrl={props.gatewayUrl}
            apiKey={props.apiKey}
            onGatewayUrlChange={(next) => {
              props.onGatewayUrlChange(next);
              probe.reset();
            }}
            onApiKeyChange={(next) => {
              props.onApiKeyChange(next);
              probe.reset();
            }}
            onOpenHelp={openHelp}
          />
        ) : (
          <HermesForm
            gatewayUrl={props.hermesGatewayUrl}
            apiKey={props.hermesApiKey}
            onGatewayUrlChange={(next) => {
              props.onHermesGatewayUrlChange(next);
              probe.reset();
            }}
            onApiKeyChange={(next) => {
              props.onHermesApiKeyChange(next);
              probe.reset();
            }}
            onOpenHelp={openHelp}
          />
        )}

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
            {prettifyProbeError(adapterType, probeErrorCode)}
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
          {helpKey === "hermes-url" && <HermesGatewayUrlHelp />}
          {helpKey === "hermes-key" && <HermesApiKeyHelp />}
        </FloatingPanel>
      )}
    </>
  );
}

function isFormReady(props: StepRuntimeProps): boolean {
  if (props.adapterType === "openclaw") {
    return (
      props.gatewayUrl.trim().length > 0 && props.apiKey.trim().length > 0
    );
  }
  return (
    props.hermesGatewayUrl.trim().length > 0 &&
    props.hermesApiKey.trim().length > 0
  );
}

function AdapterCard({
  active,
  icon,
  label,
  description,
  onSelect,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex cursor-pointer flex-col items-start gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
        active
          ? "border-emerald-400/40 bg-emerald-500/10"
          : "border-white/8 bg-white/4 hover:border-white/14 hover:bg-white/6"
      }`}
    >
      <div className="flex w-full items-center justify-between">
        <span
          className={`flex items-center gap-1.5 text-[12px] font-semibold ${
            active ? "text-emerald-100" : "text-white/85"
          }`}
        >
          <span
            className={active ? "text-emerald-300" : "text-white/55"}
          >
            {icon}
          </span>
          {label}
        </span>
        {active && (
          <CheckCircle2 className="size-3.5 text-emerald-300" />
        )}
      </div>
      <p
        className={`text-[10.5px] leading-snug ${
          active ? "text-emerald-200/65" : "text-white/45"
        }`}
      >
        {description}
      </p>
    </button>
  );
}

function OpenclawForm({
  gatewayUrl,
  apiKey,
  onGatewayUrlChange,
  onApiKeyChange,
  onOpenHelp,
}: {
  gatewayUrl: string;
  apiKey: string;
  onGatewayUrlChange: (next: string) => void;
  onApiKeyChange: (next: string) => void;
  onOpenHelp: (key: HelpKey, evt: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-white/40">
            Gateway URL
          </span>
          <HelpPill
            label="Where to find URL?"
            onClick={(e) => onOpenHelp("url", e)}
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
            onClick={(e) => onOpenHelp("key", e)}
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
    </div>
  );
}

function HermesForm({
  gatewayUrl,
  apiKey,
  onGatewayUrlChange,
  onApiKeyChange,
  onOpenHelp,
}: {
  gatewayUrl: string;
  apiKey: string;
  onGatewayUrlChange: (next: string) => void;
  onApiKeyChange: (next: string) => void;
  onOpenHelp: (key: HelpKey, evt: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-white/40">
            Gateway URL
          </span>
          <HelpPill
            label="Where to find URL?"
            onClick={(e) => onOpenHelp("hermes-url", e)}
          />
        </div>
        <input
          type="text"
          autoFocus
          value={gatewayUrl}
          onChange={(e) => onGatewayUrlChange(e.target.value)}
          placeholder="https://hermes.example.com"
          className="rounded-md border border-white/10 bg-white/5 px-3 py-2 font-mono text-[12px] text-white placeholder:text-white/30 focus:border-white/25 focus:outline-none"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-white/40">
            API_SERVER_KEY bearer
          </span>
          <HelpPill
            label="Where to find token?"
            onClick={(e) => onOpenHelp("hermes-key", e)}
          />
        </div>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => onApiKeyChange(e.target.value)}
          placeholder="—"
          autoComplete="off"
          className="rounded-md border border-white/10 bg-white/5 px-3 py-2 font-mono text-[12px] text-white placeholder:text-white/30 focus:border-white/25 focus:outline-none"
        />
      </div>
    </div>
  );
}

function HermesGatewayUrlHelp() {
  return (
    <div className="px-4 py-4 space-y-3 text-[12px] text-white/75 leading-relaxed">
      <p>
        Public HTTPS URL of your Hermes VPS&apos;s API server. OCCA hits{" "}
        <code className="font-mono text-white/85">/v1/capabilities</code> and{" "}
        <code className="font-mono text-white/85">/v1/chat/completions</code> on
        this host every time your agent runs a turn.
      </p>
      <div>
        <p className="text-white/45 text-[10.5px] uppercase tracking-wide mb-1.5">
          Bootstrap on the VPS
        </p>
        <pre className="bg-white/5 rounded-md px-2.5 py-2 font-mono text-[10.5px] text-white/80 overflow-x-auto leading-snug">{`# in ~/.hermes/.env
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
API_SERVER_KEY=<bearer>

# then install hermes as a service
sudo hermes gateway install --system --run-as-user ubuntu`}</pre>
        <p className="text-white/55 mt-2 text-[11px]">
          Front the loopback port with Caddy (or any reverse proxy) so the
          gateway is reachable over HTTPS. Enter that public URL here, e.g.{" "}
          <code className="font-mono text-white/85">
            https://hermes.example.com
          </code>
          .
        </p>
      </div>
    </div>
  );
}

function HermesApiKeyHelp() {
  return (
    <div className="px-4 py-4 space-y-3 text-[12px] text-white/75 leading-relaxed">
      <p>
        Same value you set as{" "}
        <code className="font-mono text-white/85">API_SERVER_KEY</code> in your
        VPS&apos;s <code className="font-mono text-white/85">~/.hermes/.env</code>
        . OCCA sends it on every request as{" "}
        <code className="font-mono text-white/85">Authorization: Bearer …</code>
        .
      </p>
      <div>
        <p className="text-white/45 text-[10.5px] uppercase tracking-wide mb-1.5">
          Generate a fresh one
        </p>
        <pre className="bg-white/5 rounded-md px-2.5 py-2 font-mono text-[10.5px] text-white/80 overflow-x-auto leading-snug">{`openssl rand -hex 32`}</pre>
        <p className="text-white/55 mt-2 text-[11px]">
          Rotate by changing the value in <code className="font-mono">.env</code>{" "}
          and restarting the systemd unit (
          <code className="font-mono">sudo systemctl restart hermes-gateway</code>
          ).
        </p>
      </div>
    </div>
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
  if (key === "pairing") return "Approve device pairing";
  if (key === "hermes-url") return "Hermes gateway URL";
  return "Hermes API bearer token";
}

function subtitleForHelp(key: HelpKey): string | undefined {
  if (key === "pairing") return "One-time setup";
  return undefined;
}

function prettifyProbeError(adapter: AdapterType, code: string): string {
  if (adapter === "hermes") {
    switch (code) {
      case "config_invalid":
        return "Hermes config rejected — check the gateway URL and bearer token.";
      case "unreachable":
        return "Could not reach the Hermes gateway. Is it running and DNS-reachable?";
      case "probe_timeout":
        return "Probe timed out — the Hermes gateway didn't respond in time.";
      case "unauthorized":
        return "The Hermes gateway rejected the bearer token.";
      case "invalid_response":
        return "Hermes returned an unexpected response — wrong endpoint?";
      case "probe_failed":
        return "Probe failed. Try again or check the credentials.";
      default:
        return `Probe failed (${code}).`;
    }
  }
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
