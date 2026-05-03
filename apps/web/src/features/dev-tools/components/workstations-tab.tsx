"use client";

import { Camera, X } from "lucide-react";
import {
  OFFICE_WORKSTATIONS,
  type OfficeWorkstation,
  type WorkstationKind,
} from "@/features/theater/office-anchors";
import { ZONE_DESKS, type SeatingZone } from "@occa/shared/seating";

interface WorkstationsTabProps {
  focusedWorkstationId?: string | null;
  onFocus?: (id: string | null) => void;
}

const KIND_LABEL: Record<WorkstationKind, string> = {
  executive: "Executive",
  work:      "Work",
  meeting:   "Meeting",
  lobby:     "Lobby",
  lounge:    "Lounge",
};

const KIND_DESCRIPTION: Record<WorkstationKind, string> = {
  executive: "Private / isolated chair, reserved for management roles.",
  work:      "Regular cubicle or open-desk seat with monitor — productive work.",
  meeting:   "Chair around a conference table — never assigned to a single agent.",
  lobby:     "Reception / waiting chair near the entrance.",
  lounge:    "Casual seating for breaks or informal chats.",
};

const KIND_ORDER: WorkstationKind[] = [
  "executive",
  "work",
  "meeting",
  "lobby",
  "lounge",
];

export function WorkstationsTab({
  focusedWorkstationId = null,
  onFocus,
}: WorkstationsTabProps) {
  const grouped: Record<WorkstationKind, OfficeWorkstation[]> = {
    executive: [],
    work:      [],
    meeting:   [],
    lobby:     [],
    lounge:    [],
  };
  for (const ws of Object.values(OFFICE_WORKSTATIONS)) {
    grouped[ws.kind].push(ws);
  }

  // Reverse-lookup: workstationId → seating zone. Per-agent assignment
  // happens server-side now (see @occa/shared/seating.assignSeat) so this
  // just shows which zone owns each desk; live agent occupancy is visible
  // in the Agents window.
  const zoneByWorkstation: Record<string, SeatingZone> = {};
  for (const [zone, desks] of Object.entries(ZONE_DESKS) as [
    SeatingZone,
    readonly string[],
  ][]) {
    for (const wsId of desks) zoneByWorkstation[wsId] = zone;
  }

  return (
    <div className="flex flex-col p-3 text-xs">
      {KIND_ORDER.map((kind) => {
        const items = grouped[kind];
        if (items.length === 0) return null;
        return (
          <section key={kind} className="mb-4">
            <header className="sticky top-0 z-10 flex items-baseline justify-between border-b border-white/15 bg-[#1a1c20] px-2 py-1.5">
              <h3 className="text-sm font-semibold text-white">
                {KIND_LABEL[kind]}
                <span className="ml-1.5 text-white/40">({items.length})</span>
              </h3>
              <span className="text-[10px] text-white/40">
                {KIND_DESCRIPTION[kind]}
              </span>
            </header>
            <ul className="divide-y divide-white/5">
              {items.map((ws) => {
                const zone = zoneByWorkstation[ws.id];
                const isFocused = focusedWorkstationId === ws.id;
                return (
                  <li
                    key={ws.id}
                    className={`flex items-center gap-3 px-2 py-1.5 transition-colors ${
                      isFocused ? "bg-emerald-400/10" : "hover:bg-white/5"
                    }`}
                  >
                    <span className="w-32 shrink-0 truncate font-mono text-white">
                      {ws.id}
                    </span>
                    <span className="w-24 shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-center text-[10px] text-white/60">
                      {ws.cluster}
                    </span>
                    <span className="w-32 shrink-0 truncate text-[10px] text-white/40">
                      ({ws.position.x.toFixed(1)}, {ws.position.y.toFixed(1)},{" "}
                      {ws.position.z.toFixed(1)})
                    </span>
                    <span className="flex-1 truncate text-[11px]">
                      {zone ? (
                        <span className="text-emerald-300">{zone}</span>
                      ) : (
                        <span className="text-white/30">unassigned</span>
                      )}
                    </span>
                    {onFocus && (
                      <button
                        onClick={() => onFocus(isFocused ? null : ws.id)}
                        className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors ${
                          isFocused
                            ? "bg-emerald-400/30 text-emerald-100 hover:bg-emerald-400/40"
                            : "bg-white/10 text-white/70 hover:bg-white/20 hover:text-white"
                        }`}
                        title={
                          isFocused
                            ? "Release camera"
                            : "Fly camera to this chair"
                        }
                      >
                        {isFocused ? (
                          <>
                            <X className="size-3" /> Release
                          </>
                        ) : (
                          <>
                            <Camera className="size-3" /> Focus
                          </>
                        )}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
