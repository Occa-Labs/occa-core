"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, HelpCircle, Loader2 } from "lucide-react";
import { ApiError, adaptersApi, agentsApi } from "@/lib/api";
import type { AgentDTO } from "@occa/shared/types";
import { CLAUDE_CODE_MODELS, CODEX_MODELS } from "@occa/shared/types";
import { Modal } from "@/components/ui/modal";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { Button } from "@/components/ui/button";
import { AdapterCredsHelp } from "./adapter-creds-help";

type TargetAdapter = "openclaw" | "hermes" | "claude-code" | "codex";

const ADAPTER_LABELS: Record<TargetAdapter, string> = {
  openclaw: "OpenClaw",
  hermes: "Hermes",
  "claude-code": "Claude Code",
  codex: "Codex",
};

// Runtimes whose only per-agent knob is a model picked from a gateway-backed
// list (claude-code, codex) — they share one form layout, differing only in
// the model list + copy. The HTTP adapters (openclaw, hermes) take URL + key.
const MODEL_DEFAULTS: Partial<Record<TargetAdapter, string>> = {
  "claude-code": "sonnet",
  codex: "gpt-5.5",
};

// Move an already-deployed agent to a different runtime. Provision +
// probe happen on the server inside one POST; the modal gates the action
// behind a green probe so the operator never points an agent at an
// unreachable runtime. The agent keeps serving on its current runtime
// until the switch succeeds (server does "move then cut").
export function SwitchAdapterModal({
  open,
  agent,
  onClose,
  onReloadMe,
}: {
  open: boolean;
  agent: AgentDTO;
  onClose: () => void;
  onReloadMe: () => Promise<void> | void;
}) {
  // Default the target to the OTHER runtime — switching to the one you're
  // already on is rarely the intent.
  const initialTarget: TargetAdapter =
    agent.adapterType === "openclaw" ? "hermes" : "openclaw";
  const [target, setTarget] = useState<TargetAdapter>(initialTarget);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("sonnet");
  const [probe, setProbe] = useState<{
    ok: boolean;
    latencyMs?: number;
    error?: string;
  } | null>(null);
  const [phase, setPhase] = useState<"idle" | "probing" | "switching">("idle");
  const [error, setError] = useState<string | null>(null);

  // Per-runtime "where do I find the URL + key" help popover.
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpRect, setHelpRect] = useState<DOMRect | null>(null);
  const helpTriggerRef = useRef<HTMLButtonElement>(null);
  const openHelp = useCallback(() => {
    setHelpRect(helpTriggerRef.current?.getBoundingClientRect() ?? null);
    setHelpOpen(true);
  }, []);

  // Reset everything when the modal (re)opens.
  useEffect(() => {
    if (!open) return;
    setTarget(initialTarget);
    setGatewayUrl("");
    setApiKey("");
    setModel("sonnet");
    setProbe(null);
    setPhase("idle");
    setError(null);
    setHelpOpen(false);
    // initialTarget is derived from agent.adapterType — stable per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Changing the target invalidates a stale probe (creds differ). For a
  // model-backed runtime, also reset the model to that runtime's default so a
  // stale "sonnet" doesn't carry into a codex switch (and vice versa).
  const handleTargetChange = useCallback((next: TargetAdapter) => {
    setTarget((prev) => {
      if (prev === next) return prev;
      setProbe(null);
      setError(null);
      const def = MODEL_DEFAULTS[next];
      if (def) setModel(def);
      return next;
    });
  }, []);

  // Every runtime is reached over a gateway (claude-code is gateway-only
  // BYORT, like openclaw / hermes), so all need a gateway URL + bearer.
  const canProbe =
    phase === "idle" &&
    gatewayUrl.trim().length > 0 &&
    apiKey.trim().length > 0;

  const handleProbe = useCallback(async () => {
    setPhase("probing");
    setProbe(null);
    setError(null);
    try {
      const res =
        target === "claude-code"
          ? await adaptersApi.probeClaudeCode({
              model,
              ...(gatewayUrl.trim() && apiKey.trim()
                ? { gatewayUrl: gatewayUrl.trim(), apiKey: apiKey.trim() }
                : {}),
            })
          : target === "codex"
            ? await adaptersApi.probeCodex({
                model,
                ...(gatewayUrl.trim() && apiKey.trim()
                  ? { gatewayUrl: gatewayUrl.trim(), apiKey: apiKey.trim() }
                  : {}),
              })
            : target === "openclaw"
              ? await adaptersApi.probeOpenclaw({
                  gatewayUrl: gatewayUrl.trim(),
                  apiKey: apiKey.trim(),
                })
              : await adaptersApi.probeHermes({
                  gatewayUrl: gatewayUrl.trim(),
                  apiKey: apiKey.trim(),
                });
      setProbe({ ok: res.ok, latencyMs: res.latencyMs, error: res.error });
    } catch (e) {
      setProbe({
        ok: false,
        error:
          e instanceof ApiError
            ? ((e.body as { error?: string } | null)?.error ?? `http_${e.status}`)
            : "network_error",
      });
    } finally {
      setPhase("idle");
    }
  }, [target, gatewayUrl, apiKey, model]);

  const handleConfirm = useCallback(async () => {
    setPhase("switching");
    setError(null);
    try {
      if (target === "claude-code") {
        await agentsApi.switchAdapter(agent.id, {
          adapterType: "claude-code",
          adapterConfig: {
            model,
            ...(gatewayUrl.trim() && apiKey.trim()
              ? { gatewayUrl: gatewayUrl.trim(), apiKey: apiKey.trim() }
              : {}),
          },
        });
      } else if (target === "codex") {
        await agentsApi.switchAdapter(agent.id, {
          adapterType: "codex",
          adapterConfig: {
            model,
            gatewayUrl: gatewayUrl.trim(),
            apiKey: apiKey.trim(),
          },
        });
      } else {
        await agentsApi.switchAdapter(agent.id, {
          adapterType: target,
          adapterConfig: { gatewayUrl: gatewayUrl.trim(), apiKey: apiKey.trim() },
        });
      }
      await onReloadMe();
      onClose();
    } catch (e) {
      const reason =
        e instanceof ApiError
          ? ((e.body as { reason?: string; error?: string } | null)?.reason ??
            (e.body as { error?: string } | null)?.error ??
            `http_${e.status}`)
          : "network_error";
      setError(reason);
      setPhase("idle");
    }
  }, [agent.id, target, gatewayUrl, apiKey, model, onReloadMe, onClose]);

  const probedOk = probe?.ok === true;

  return (
    <Modal open={open} onClose={onClose} title="Switch runtime adapter">
      <div className="px-5 py-4 space-y-4">
        <p className="text-[11px] text-white/50 leading-relaxed">
          Move <span className="text-white/80">{agent.name}</span> to a
          different runtime. Identity, role, hierarchy, seat, and task history
          stay — only the runtime backing the agent changes. The agent keeps
          serving on{" "}
          <span className="font-mono text-white/70">{agent.adapterType}</span>{" "}
          until the new runtime is ready.
        </p>

        {/* Target adapter tabs */}
        <div className="flex gap-1.5">
          {(Object.keys(ADAPTER_LABELS) as TargetAdapter[]).map((a) => {
            const isCurrent = a === agent.adapterType;
            const selected = a === target;
            return (
              <button
                key={a}
                type="button"
                onClick={() => handleTargetChange(a)}
                disabled={phase !== "idle"}
                className={`flex-1 rounded-md px-3 py-2 text-xs font-medium transition ring-1 ring-inset disabled:opacity-50 ${
                  selected
                    ? "bg-white/12 ring-white/25 text-white"
                    : "bg-white/4 ring-white/8 text-white/60 hover:bg-white/8 hover:text-white/85"
                }`}
              >
                {ADAPTER_LABELS[a]}
                {isCurrent && (
                  <span className="ml-1 text-[9px] text-white/40">current</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Per-runtime help — sits right above the creds so it gets noticed.
            Content tracks the selected target (URL + bearer for all three). */}
        <button
          ref={helpTriggerRef}
          type="button"
          onClick={openHelp}
          className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-3 py-2 text-[11.5px] text-white/45 transition-colors hover:bg-white/5 hover:text-white/75"
          style={{ border: "1px dashed rgba(255,255,255,0.10)" }}
        >
          <HelpCircle className="size-3.5 shrink-0" />
          Where do I find the {ADAPTER_LABELS[target]} Gateway URL and API key?
        </button>

        {/* Config — claude-code / codex pick a model + a gateway (host auth
            lives on the box); the HTTP adapters collect gateway + bearer. */}
        {target === "claude-code" || target === "codex" ? (
          <div className="space-y-2.5">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-white/40">
                Model
              </span>
              <select
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setProbe(null);
                }}
                className="mt-1 w-full rounded-md border border-white/12 bg-white/5 px-3 py-2 text-xs text-white/90 font-mono focus:outline-none focus:ring-1 focus:ring-white/25"
              >
                {(target === "codex" ? CODEX_MODELS : CLAUDE_CODE_MODELS).map(
                  (m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ),
                )}
              </select>
            </label>
            <p className="text-[10px] text-white/35 leading-relaxed">
              {target === "codex"
                ? "Runs on OpenAI Codex via a Codex Gateway on the host box. gpt-5.5 is newest; gpt-5.4-mini is cheapest."
                : "Runs on a Claude subscription via a Claude Gateway on the host box. Sonnet is the efficient default; Fable is most capable but priciest."}
            </p>
            <div className="space-y-2.5 rounded-md border border-white/10 bg-white/2 p-2.5">
              <span className="text-[10px] uppercase tracking-wider text-white/40">
                {target === "codex"
                  ? "Codex Gateway (BYORT)"
                  : "Claude Gateway (BYORT)"}
              </span>
              <input
                value={gatewayUrl}
                onChange={(e) => {
                  setGatewayUrl(e.target.value);
                  setProbe(null);
                }}
                placeholder={
                  target === "codex"
                    ? "https://codex.your-box.com"
                    : "https://claude.your-box.com"
                }
                className="w-full rounded-md border border-white/12 bg-white/5 px-3 py-2 text-xs text-white/90 font-mono focus:outline-none focus:ring-1 focus:ring-white/25"
              />
              <input
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setProbe(null);
                }}
                type="password"
                placeholder="gateway bearer (required with a gateway)"
                className="w-full rounded-md border border-white/12 bg-white/5 px-3 py-2 text-xs text-white/90 font-mono focus:outline-none focus:ring-1 focus:ring-white/25"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-white/40">
                Gateway URL
              </span>
              <input
                value={gatewayUrl}
                onChange={(e) => {
                  setGatewayUrl(e.target.value);
                  setProbe(null);
                }}
                placeholder={
                  target === "hermes"
                    ? "https://hermes.occa.team"
                    : "wss://gateway.occa.team"
                }
                className="mt-1 w-full rounded-md border border-white/12 bg-white/5 px-3 py-2 text-xs text-white/90 font-mono focus:outline-none focus:ring-1 focus:ring-white/25"
              />
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-white/40">
                Bearer / API key
              </span>
              <input
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setProbe(null);
                }}
                type="password"
                placeholder="paste runtime token"
                className="mt-1 w-full rounded-md border border-white/12 bg-white/5 px-3 py-2 text-xs text-white/90 font-mono focus:outline-none focus:ring-1 focus:ring-white/25"
              />
            </label>
          </div>
        )}

        {/* Probe result */}
        {probe && (
          <div
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-[11px] ring-1 ring-inset ${
              probe.ok
                ? "bg-emerald-500/10 ring-emerald-500/25 text-emerald-200"
                : "bg-red-500/10 ring-red-500/20 text-red-300"
            }`}
          >
            {probe.ok ? (
              <CheckCircle2 className="size-3.5 shrink-0" />
            ) : (
              <AlertCircle className="size-3.5 shrink-0" />
            )}
            {probe.ok
              ? `Reachable — ${probe.latencyMs ?? "?"}ms. Ready to switch.`
              : `Unreachable — ${probe.error ?? "probe failed"}`}
          </div>
        )}

        {/* Switch error */}
        {error && (
          <div className="flex items-start gap-2 rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-300 ring-1 ring-inset ring-red-500/18">
            <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
            <span className="font-mono wrap-break-word">{error}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-1">
          {!probedOk ? (
            <Button
              type="button"
              variant="secondary"
              disabled={!canProbe}
              onClick={handleProbe}
            >
              {phase === "probing" ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> Probing…
                </>
              ) : (
                "Probe"
              )}
            </Button>
          ) : (
            <Button
              type="button"
              variant="success"
              disabled={phase === "switching"}
              onClick={handleConfirm}
            >
              {phase === "switching" ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> Switching…
                </>
              ) : (
                `Switch to ${ADAPTER_LABELS[target]}`
              )}
            </Button>
          )}
        </div>
      </div>

      {helpOpen && (
        <FloatingPanel
          title={`${ADAPTER_LABELS[target]} credentials`}
          subtitle="Where to get the URL + key"
          triggerRect={helpRect}
          width={420}
          zIndex={300}
          backdrop="transparent"
          onClose={() => setHelpOpen(false)}
        >
          <AdapterCredsHelp adapter={target} />
        </FloatingPanel>
      )}
    </Modal>
  );
}
