"use client";

// Top-level Chats window — 3-column observer view across the chat
// surface. Col 1 picks a viewer (the user or an agent); Col 2 lists the
// counterparts that viewer has ever talked to; Col 3 renders the merged
// conversation between (viewer, counterpart) with thread separators.
//
// Phase 3 ships Cols 1+2; Col 3 is a placeholder until Phase 4.

import { useEffect, useState } from "react";
import type { AgentDTO } from "@occa/shared/types";
import { AppWindow } from "@/components/ui/app-window";
import { AgentsColumn } from "./agents-column";
import { PartnersColumn } from "./partners-column";
import { MessagesColumn } from "./messages-column";
import { type InboxParty } from "../types";

interface ChatsWindowProps {
  agents: AgentDTO[];
  onClose?: () => void;
}

const INITIAL_VIEWER: InboxParty = { kind: "user" };

export function ChatsWindow({ agents, onClose }: ChatsWindowProps) {
  const [viewer, setViewer] = useState<InboxParty>(INITIAL_VIEWER);
  const [partner, setPartner] = useState<InboxParty | null>(null);

  // Switching viewer invalidates the current partner — the counterpart
  // list is per-viewer, so the previous selection has no meaning under
  // the new viewer.
  useEffect(() => {
    setPartner(null);
  }, [viewer]);

  const viewerLabel = labelForParty(viewer, agents);
  const partnerLabel = partner ? labelForParty(partner, agents) : null;

  return (
    <AppWindow
      title="Chats"
      subtitle={
        viewer.kind === "user"
          ? "Your conversations"
          : `${viewerLabel}'s conversations`
      }
      onClose={onClose}
      defaultSize={{
        w: Math.min(1100, Math.round(window.innerWidth * 0.85)),
        h: Math.min(700, Math.round(window.innerHeight * 0.82)),
      }}
      minWidth={820}
      minHeight={480}
    >
      <div className="flex h-full overflow-hidden">
        <AgentsColumn
          agents={agents}
          selected={viewer}
          onSelect={setViewer}
        />
        <PartnersColumn
          viewer={viewer}
          viewerLabel={viewerLabel}
          agents={agents}
          selectedPartner={partner}
          onSelectPartner={setPartner}
        />
        <MessagesColumn
          viewer={viewer}
          viewerLabel={viewerLabel}
          partner={partner}
          partnerLabel={partnerLabel}
          agents={agents}
        />
      </div>
    </AppWindow>
  );
}

function labelForParty(p: InboxParty, agents: AgentDTO[]): string {
  if (p.kind === "user") return "You";
  return agents.find((a) => a.id === p.deploymentId)?.name ?? "Unknown";
}
