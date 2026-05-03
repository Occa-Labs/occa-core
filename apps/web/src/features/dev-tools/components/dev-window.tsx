"use client";

import { useState } from "react";
import type { AgentDTO } from "@occa/shared/types";
import { AppWindow } from "@/components/ui/app-window";
import { WorkstationsTab } from "./workstations-tab";
import { AgentsTab } from "./agents-tab";
import { MapTab } from "./map-tab";
import { RecordTab } from "./record-tab";

type DevStatus = "idle" | "working" | "talking" | "meeting";
type AgentOverride = {
  workstationId?: string | null;
  status?:        DevStatus | null;
};

interface DevWindowProps {
  onClose?: () => void;
  /** Currently camera-focused workstation (mirrors the value held in
   *  page.tsx). Used to highlight the active row in the workstations tab. */
  focusedWorkstationId?: string | null;
  /** Set / clear camera focus on a chair. Pass `null` to release. */
  onFocusWorkstation?: (id: string | null) => void;
  /** Live agent list from useMe — drives the Agents tab. */
  agents?: AgentDTO[];
  /** Per-role dev overrides (workstation + animation status). */
  agentDevOverrides?: Record<string, AgentOverride>;
  /** Setter for a single role's override. */
  onUpdateAgentDevOverride?: (role: string, patch: AgentOverride) => void;
  /** Walk-path recorder mode (drives `devWalkRecord` upstream). */
  devWalkRecord?: boolean;
  /** Toggles the recorder on/off — flipping to off emits the captured
   *  path through the on-scene modal. */
  onToggleWalkRecord?: () => void;
}

type TabId = "workstations" | "agents" | "map" | "record";

const TABS: { id: TabId; label: string }[] = [
  { id: "workstations", label: "Workstations" },
  { id: "agents", label: "Agents" },
  { id: "map", label: "Map" },
  { id: "record", label: "Record" },
];

export function DevWindow({
  onClose,
  focusedWorkstationId = null,
  onFocusWorkstation,
  agents = [],
  agentDevOverrides = {},
  onUpdateAgentDevOverride,
  devWalkRecord = false,
  onToggleWalkRecord,
}: DevWindowProps) {
  const [active, setActive] = useState<TabId>("workstations");

  return (
    <AppWindow
      title="Dev Tools"
      subtitle="Inspect 3D scene mappings and other dev-only views"
      onClose={onClose}
      defaultSize={{ w: 720, h: 560 }}
      minWidth={520}
      minHeight={360}
    >
      <div className="flex h-full flex-col">
        <nav className="flex border-b border-white/10 px-3">
          {TABS.map((tab) => {
            const isActive = active === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActive(tab.id)}
                className={`px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? "border-b-2 border-white text-white"
                    : "text-white/50 hover:text-white/80"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
        <div className="flex-1 overflow-y-auto">
          {active === "workstations" && (
            <WorkstationsTab
              focusedWorkstationId={focusedWorkstationId}
              onFocus={onFocusWorkstation}
            />
          )}
          {active === "agents" && (
            <AgentsTab
              agents={agents}
              overrides={agentDevOverrides}
              onUpdate={onUpdateAgentDevOverride}
            />
          )}
          {active === "map" && <MapTab />}
          {active === "record" && (
            <RecordTab
              active={devWalkRecord}
              onToggle={onToggleWalkRecord}
            />
          )}
        </div>
      </div>
    </AppWindow>
  );
}
