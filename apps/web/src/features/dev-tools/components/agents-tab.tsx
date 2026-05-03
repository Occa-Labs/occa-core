"use client";

import { useMemo, useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";
import type { AgentDTO } from "@occa/shared/types";
import { buildAgentModelMap } from "@/features/theater/constants";
import { OFFICE_WORKSTATIONS } from "@/features/theater/office-anchors";
import { deriveAgentStatus } from "@/features/theater/utils";
import { formatRoleLabel } from "@/lib/format-role";

type DevStatus = "idle" | "working" | "talking" | "meeting";
type Override = {
  workstationId?: string | null;
  status?:        DevStatus | null;
};

// Demo scene only renders these four statuses — anything else from the
// real activity machine (connecting / provisioning / offline / error /
// cooldown) collapses to "working" so the copied agent still shows up
// at their desk instead of disappearing.
const DEMO_STATUS_SAFE = new Set<DevStatus>([
  "idle",
  "working",
  "talking",
  "meeting",
]);

interface AgentsTabProps {
  agents: AgentDTO[];
  overrides: Record<string, Override>;
  onUpdate?: (role: string, patch: Override) => void;
}

const STATUS_OPTIONS: DevStatus[] = ["idle", "working", "talking", "meeting"];

// Sorted workstation ids for the dropdown — grouped by kind so the picker
// reads as a structured list rather than 40 random ids in a flat select.
const WORKSTATION_OPTIONS = Object.values(OFFICE_WORKSTATIONS)
  .slice()
  .sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.id.localeCompare(b.id);
  });

export function AgentsTab({ agents, overrides, onUpdate }: AgentsTabProps) {
  // Local controlled inputs so changes feel snappy even if the parent
  // setter is throttled. The parent state is the source of truth on rerender.
  const [touched, setTouched] = useState(0);
  const [copied, setCopied] = useState(false);

  // Resolved model per agent — same algorithm office-scene runs, so the
  // copied snapshot pins what the user is actually seeing right now.
  const agentModels = useMemo(
    () =>
      buildAgentModelMap(
        agents.map((a) => ({
          id: a.id,
          role: a.role,
          createdAt: a.createdAt,
          modelOverride: a.modelOverride,
        })),
      ),
    [agents],
  );

  const handleCopyDemoData = async () => {
    const sorted = [...agents].sort((a, b) => {
      const ca = a.createdAt ?? "";
      const cb = b.createdAt ?? "";
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
    const entries = sorted.map((a) => {
      const ov = overrides[a.role] ?? {};
      const workstationId = ov.workstationId ?? a.workstationId ?? null;
      const live = deriveAgentStatus(a) as DevStatus;
      const status =
        ov.status ?? (DEMO_STATUS_SAFE.has(live) ? live : "working");
      const modelOverride = agentModels.get(a.id) ?? a.modelOverride ?? null;
      return [
        "  {",
        `    id: ${JSON.stringify(a.id)},`,
        `    name: ${JSON.stringify(a.name)},`,
        `    role: ${JSON.stringify(a.role)},`,
        `    status: ${JSON.stringify(status)},`,
        `    ready: true,`,
        `    workstationId: ${JSON.stringify(workstationId)},`,
        `    createdAt: ${JSON.stringify(a.createdAt)},`,
        `    modelOverride: ${JSON.stringify(modelOverride)},`,
        "  },",
      ].join("\n");
    });
    const code = `[\n${entries.join("\n")}\n]`;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (insecure context). Fall back to a prompt
      // so the user can still grab the text manually.
      window.prompt("Copy demo data:", code);
    }
  };

  if (agents.length === 0) {
    return (
      <div className="p-4 text-sm text-white/50">
        No agents in this company yet. Hire someone via the Agents window first.
      </div>
    );
  }

  const setRoleOverride = (role: string, patch: Override) => {
    onUpdate?.(role, patch);
    setTouched((n) => n + 1);
  };

  return (
    <div className="flex flex-col gap-2 p-3 text-xs">
      <header className="border-b border-white/10 px-2 pb-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-white">Agents</h3>
          <span className="text-[10px] text-white/40">
            Force a chair / animation status (dev override, not persisted).
          </span>
        </div>
        <div className="mt-1.5 flex justify-end">
          <button
            type="button"
            onClick={handleCopyDemoData}
            className="inline-flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-[11px] text-white/80 hover:bg-white/20 hover:text-white"
            title="Copy current seats + resolved models as demo-data entries"
          >
            {copied ? (
              <>
                <Check className="size-3" /> Copied
              </>
            ) : (
              <>
                <Copy className="size-3" /> Copy demo data
              </>
            )}
          </button>
        </div>
      </header>
      <ul className="divide-y divide-white/5">
        {agents.map((a) => {
          const ov = overrides[a.role] ?? {};
          return (
            <li
              key={a.id}
              data-touched={touched}
              className="flex items-center gap-2 px-2 py-2"
            >
              <div className="w-40 shrink-0">
                <div className="truncate font-mono text-white">{a.role}</div>
                <div className="truncate text-[10px] text-white/40">
                  {formatRoleLabel(a.role)} · {a.name}
                </div>
              </div>

              <label className="flex flex-col gap-0.5 text-[10px]">
                <span className="text-white/40">Workstation</span>
                <select
                  value={ov.workstationId ?? ""}
                  onChange={(e) =>
                    setRoleOverride(a.role, {
                      workstationId: e.target.value || null,
                    })
                  }
                  className="w-44 rounded bg-white/10 px-1.5 py-1 text-white"
                >
                  <option value="">(default — auto)</option>
                  {WORKSTATION_OPTIONS.map((w) => (
                    <option key={w.id} value={w.id}>
                      [{w.kind}] {w.id}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-0.5 text-[10px]">
                <span className="text-white/40">Status</span>
                <select
                  value={ov.status ?? ""}
                  onChange={(e) =>
                    setRoleOverride(a.role, {
                      status: (e.target.value as DevStatus) || null,
                    })
                  }
                  className="w-28 rounded bg-white/10 px-1.5 py-1 text-white"
                >
                  <option value="">(real)</option>
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>

              <button
                onClick={() =>
                  setRoleOverride(a.role, {
                    workstationId: null,
                    status: null,
                  })
                }
                className="ml-auto inline-flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-[11px] text-white/70 hover:bg-white/20 hover:text-white"
                title="Clear all overrides for this role"
              >
                <RotateCcw className="size-3" /> Reset
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
