"use client";

// Standalone OS window for the full company org chart. Lets the user
// see the entire hierarchy (CEO → Heads → Specialists) without first
// opening Agents and selecting a node. Read-only here — reassignment
// happens in the per-agent Settings tab inside AgentsWindow.
//
// Click a node in the tree → `onOpenAgent` is invoked so OsShell can
// route to AgentsWindow with that agent pre-selected.

import { useState } from "react";
import { AppWindow } from "@/components/ui/app-window";
import type { AgentDTO } from "@occa/shared/types";
import { OrgChartCanvas } from "./org-chart-canvas";

export function OrgChartWindow({
  companyName,
  agents,
  onClose,
  onOpenAgent,
}: {
  companyName: string;
  agents: AgentDTO[];
  onClose: () => void;
  onOpenAgent: (agentId: string) => void;
}) {
  // Local selected state — used purely for the visual highlight inside
  // the canvas. The actual navigation away from this window happens via
  // `onOpenAgent` (parent decides what to do).
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <AppWindow
      title="Org Chart"
      subtitle={`${agents.length} agent${agents.length !== 1 ? "s" : ""} — ${companyName}`}
      onClose={onClose}
      defaultSize={{
        w: Math.min(960, Math.round(window.innerWidth * 0.72)),
        h: Math.min(700, Math.round(window.innerHeight * 0.82)),
      }}
      minWidth={520}
      minHeight={400}
    >
      <div className="h-full w-full bg-black/20">
        <OrgChartCanvas
          agents={agents}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            onOpenAgent(id);
          }}
        />
      </div>
    </AppWindow>
  );
}
