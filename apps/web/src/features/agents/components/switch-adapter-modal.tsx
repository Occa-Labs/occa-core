"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { ApiError, adaptersApi, agentsApi } from "@/lib/api";
import type { AgentDTO } from "@occa/shared/types";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";

type TargetAdapter = "openclaw" | "hermes" | "claude-code";

const ADAPTER_LABELS: Record<TargetAdapter, string> = {
  openclaw: "OpenClaw",
  hermes: "Hermes",
  "claude-code": "Claude Code",
};

// Claude Code has no gateway/bearer — auth is host-level — so the only
// per-agent knob is the model.
const CLAUDE_CODE_MODELS = ["sonnet", "opus", "haiku"];

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
    // initialTarget is derived from agent.adapterType — stable per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Changing the target invalidates a stale probe (creds differ).
  const handleTargetChange = useCallback((next: TargetAdapter) => {
    setTarget((prev) => {
      if (prev === next) return prev;
      setProbe(null);
      setError(null);
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

        {/* Config — claude-code is credential-less (host auth), so it only
            picks a model; the HTTP adapters collect gateway + bearer. */}
        {target === "claude-code" ? (
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
                {CLAUDE_CODE_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-[10px] text-white/35 leading-relaxed">
              Runs on a Claude subscription via a Claude Gateway on the host
              box. sonnet is cheapest; opus for higher quality.
            </p>
            <div className="space-y-2.5 rounded-md border border-white/10 bg-white/2 p-2.5">
              <span className="text-[10px] uppercase tracking-wider text-white/40">
                Claude Gateway (BYORT)
              </span>
              <input
                value={gatewayUrl}
                onChange={(e) => {
                  setGatewayUrl(e.target.value);
                  setProbe(null);
                }}
                placeholder="https://claude.your-box.com"
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
    </Modal>
  );
}
