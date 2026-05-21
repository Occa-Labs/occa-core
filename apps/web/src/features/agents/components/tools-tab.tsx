"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Loader2,
  Plug,
  ShieldCheck,
  Users,
  Wrench,
} from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { useCompanyTools } from "@/features/tools/api/use-tools";
import { useAgentTools } from "@/features/agents/api/use-agent-tools";
import { ApiError } from "@/lib/api";
import type { AgentDTO, CompanyToolDTO } from "@occa/shared/types";

type SaveState = "idle" | "saving" | "saved" | "error";

export function ToolsTab({
  agent,
  onReloadMe,
}: {
  agent: AgentDTO;
  onReloadMe: () => Promise<void> | void;
}) {
  const {
    tools,
    loading,
    error,
  } = useCompanyTools(agent.companyId, true);
  const { syncEnabledTools } = useAgentTools(onReloadMe);

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(agent.enabledTools),
  );
  const [save, setSave] = useState<SaveState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Reset on agent switch so the per-agent toggle state follows the
  // server snapshot rather than leaking selections across rows.
  useEffect(() => {
    setSelected(new Set(agent.enabledTools));
    setSave("idle");
    setErrorMsg(null);
  }, [agent.id, agent.enabledTools]);

  const pendingRef = useRef<Set<string> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    const next = pendingRef.current;
    if (!next) return;
    pendingRef.current = null;
    setSave("saving");
    setErrorMsg(null);
    try {
      await syncEnabledTools(agent.id, Array.from(next));
      setSave("saved");
      setTimeout(() => {
        setSave((s) => (s === "saved" ? "idle" : s));
      }, 1200);
    } catch (e) {
      setSave("error");
      if (e instanceof ApiError) {
        const body = e.body as { error?: string; ids?: string[] } | null;
        if (body?.error === "unknown_tool_ids") {
          setErrorMsg(`Unknown tools: ${(body.ids ?? []).join(", ")}`);
        } else {
          setErrorMsg(body?.error ?? `http_${e.status}`);
        }
      } else {
        setErrorMsg("network_error");
      }
    }
  }, [agent.id, syncEnabledTools]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const toggle = useCallback(
    (id: string, disallowed?: boolean) => {
      if (disallowed) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        pendingRef.current = next;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          void flush();
        }, 500);
        return next;
      });
    },
    [flush],
  );

  // Partition available (visible to this role) vs orphan IDs (enabled in
  // profile but the tool was deleted out from under it).
  const { available, orphans } = useMemo(() => {
    const byId = new Map(tools.map((t) => [t.id, t]));
    const orphanIds = Array.from(selected).filter((id) => !byId.has(id));
    return { available: tools, orphans: orphanIds };
  }, [tools, selected]);

  return (
    <div className="p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white/90">
            Available tools ({available.length})
          </h3>
          <p className="text-xs text-white/40 mt-0.5">
            Pick which company tools this agent can call. Changes save automatically.
          </p>
        </div>
        <SaveIndicator state={save} errorMsg={errorMsg} />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-white/40 py-8 justify-center">
          <Loader2 className="size-3.5 animate-spin" /> Loading tools…
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 text-xs text-red-300/80 py-8 justify-center">
          <AlertCircle className="size-3.5" /> Failed to load tools ({error})
        </div>
      ) : available.length === 0 ? (
        <div className="glass-light rounded-lg p-4 text-xs text-white/50">
          No tools installed for this company. Open the Tools window to install one.
        </div>
      ) : (
        <div className="space-y-1">
          {available.map((tool) => {
            const allowed = roleAllows(tool, agent.role);
            return (
              <ToolRow
                key={tool.id}
                tool={tool}
                agentRole={agent.role}
                checked={selected.has(tool.id)}
                disallowed={!allowed}
                onToggle={() => toggle(tool.id, !allowed)}
              />
            );
          })}
        </div>
      )}

      {orphans.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-[11px] uppercase tracking-wide text-white/40">
            Enabled but missing ({orphans.length})
          </h4>
          <div className="space-y-1">
            {orphans.map((id) => (
              <div
                key={id}
                className="flex items-center justify-between glass-light rounded-md px-3 py-2"
              >
                <span className="text-xs text-white/60 font-mono truncate">
                  {id}
                </span>
                <button
                  onClick={() => toggle(id)}
                  className="text-[11px] text-red-300/80 hover:text-red-300 cursor-pointer"
                >
                  Disable
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function roleAllows(tool: CompanyToolDTO, role: string): boolean {
  if (!tool.allowedRoles || tool.allowedRoles.length === 0) return true;
  return tool.allowedRoles.includes(role);
}

function SaveIndicator({
  state,
  errorMsg,
}: {
  state: SaveState;
  errorMsg: string | null;
}) {
  if (state === "saving") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-white/50">
        <Loader2 className="size-3 animate-spin" /> Saving…
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="text-[11px] text-emerald-300/80">Saved</span>
    );
  }
  if (state === "error") {
    return (
      <span
        className="text-[11px] text-red-300/80 truncate max-w-[260px]"
        title={errorMsg ?? undefined}
      >
        {errorMsg ?? "Save failed"}
      </span>
    );
  }
  return null;
}

function ToolRow({
  tool,
  agentRole,
  checked,
  disallowed,
  onToggle,
}: {
  tool: CompanyToolDTO;
  agentRole: string;
  checked: boolean;
  disallowed: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={`flex items-start gap-3 glass-light rounded-lg px-3 py-2.5 transition-colors ${
        disallowed ? "opacity-50" : "hover:bg-white/6"
      }`}
    >
      <div className="size-7 rounded-md bg-white/8 flex items-center justify-center shrink-0 mt-0.5">
        {tool.status === "active" ? (
          <Plug className="size-3.5 text-white/60" />
        ) : (
          <Wrench className="size-3.5 text-amber-300/70" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-[13px] text-white/90 font-medium truncate">
            {tool.label}
          </p>
          <span className="text-[10px] text-white/40 truncate">
            {tool.displayName}
          </span>
        </div>
        <div className="mt-1.5">
          <RoleBadges roles={tool.allowedRoles} />
        </div>
        {disallowed && (
          <p className="text-[10px] text-amber-300/70 mt-1">
            Restricted to other roles. Agent role <span className="font-mono">{agentRole}</span> not in allowed list.
          </p>
        )}
      </div>
      <Toggle
        checked={checked}
        onChange={onToggle}
        disabled={disallowed}
      />
    </div>
  );
}

function RoleBadges({ roles }: { roles: string[] }) {
  if (!roles || roles.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-white/40">
        <Users className="size-3" /> All roles
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      <ShieldCheck className="size-3 text-amber-300/70 shrink-0" />
      {roles.map((r) => (
        <span
          key={r}
          className="text-[10px] uppercase tracking-wide font-medium rounded px-1.5 py-0.5 bg-amber-500/10 text-amber-200/90"
        >
          {r}
        </span>
      ))}
    </span>
  );
}
