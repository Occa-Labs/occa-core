"use client";

import { useState } from "react";
import { Eraser, MousePointer2, ClipboardCopy, Check } from "lucide-react";
import {
  devMapActions,
  exportCellsAsCode,
  useDevMap,
  type MapKind,
} from "@/lib/dev-map-store";

// Map editor tab. Two paint modes — "Stand Area" and "Sit Area" — that
// each let the user mark floor cells where idle agents may be placed.
// Future modes (walk path, exit path, no-go zones) reuse this surface
// and share the FloorGrid renderer in the 3D scene.

const LEGEND_ITEMS = [
  { swatch: "bg-cyan-400",    label: "hovered" },
  { swatch: "bg-yellow-400",  label: "pending" },
  { swatch: "bg-blue-500",    label: "stand saved" },
  { swatch: "bg-emerald-500", label: "sit saved" },
] as const;

const KIND_LABEL: Record<MapKind, string> = {
  stand: "Stand area",
  sit:   "Sit area",
};
const KIND_BTN_LABEL: Record<MapKind, string> = {
  stand: "Setting Stand Area",
  sit:   "Setting Sit Area",
};
const KIND_BTN_ACTIVE_COLOR: Record<MapKind, string> = {
  stand: "bg-cyan-500 text-black hover:bg-cyan-400",
  sit:   "bg-emerald-500 text-black hover:bg-emerald-400",
};

export function MapTab() {
  const { mode, cells, pending } = useDevMap();
  const [copiedKind, setCopiedKind] = useState<MapKind | null>(null);

  const standCount = cells.filter((c) => c.kind === "stand").length;
  const sitCount   = cells.filter((c) => c.kind === "sit").length;

  const copyKind = async (kind: MapKind) => {
    const code = exportCellsAsCode(cells, kind);
    try {
      await navigator.clipboard.writeText(code);
      setCopiedKind(kind);
      setTimeout(() => setCopiedKind(null), 1500);
    } catch {
      /* clipboard blocked — silent, user can re-try after granting permission */
    }
  };

  return (
    <div className="flex flex-col gap-3 p-4 text-xs">
      <header className="border-b border-white/10 pb-2">
        <h3 className="text-sm font-semibold text-white">Map Editor</h3>
        <p className="mt-1 text-[11px] text-white/50">
          Data-collection only. Paint floor cells to mark candidate
          positions; saved per browser (localStorage). Painted cells do
          NOT affect live agents — use <em>Copy as code</em> and paste
          into <code>idle-anchors.ts</code> to ship as defaults.
        </p>
      </header>

      {(["stand", "sit"] as MapKind[]).map((kind) => {
        const active = mode === kind;
        return (
          <section
            key={kind}
            className="rounded-md border border-white/10 bg-white/5 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-[13px] font-medium text-white">
                  {KIND_LABEL[kind]}
                </div>
                <div className="text-[11px] text-white/50">
                  Two-click flow: 1st click places the spot, 2nd click sets the
                  facing direction. Click an existing spot of the same kind
                  to delete.
                </div>
              </div>
              <button
                onClick={() => devMapActions.setMode(active ? "off" : kind)}
                className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] font-medium transition-colors ${
                  active
                    ? KIND_BTN_ACTIVE_COLOR[kind]
                    : "bg-white/10 text-white hover:bg-white/20"
                }`}
              >
                <MousePointer2 className="size-3.5" />
                {active ? "Editing — click to stop" : KIND_BTN_LABEL[kind]}
              </button>
            </div>

            {active && (
              <div className="mt-3 rounded bg-black/30 p-2 text-[11px] text-white/70">
                <ul className="flex flex-wrap items-center gap-3">
                  {LEGEND_ITEMS.map((item) => (
                    <li key={item.label} className="flex items-center gap-1.5">
                      <span
                        className={`inline-block size-2 rounded-sm ${item.swatch}`}
                      />
                      {item.label}
                    </li>
                  ))}
                </ul>
                {pending && (
                  <div className="mt-1.5 text-yellow-300">
                    Pending at ({pending.x}, {pending.z}) — click any cell to
                    set the facing direction. Click the same cell to cancel.
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}

      <section className="rounded-md border border-white/10 bg-white/5 p-3">
        <div className="text-[12px] font-medium text-white">
          {standCount} stand · {sitCount} sit cell
          {standCount + sitCount === 1 ? "" : "s"} saved
        </div>
        <div className="mt-1 text-[11px] text-white/50">
          Stored under <code className="text-white/70">occa.dev.map</code>.
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(["stand", "sit"] as MapKind[]).map((kind) => {
            const count = kind === "stand" ? standCount : sitCount;
            return (
              <span key={kind} className="flex items-center gap-2">
                <button
                  onClick={() => copyKind(kind)}
                  disabled={count === 0}
                  className="inline-flex items-center gap-1.5 rounded bg-white/10 px-2.5 py-1.5 text-[12px] text-white hover:bg-white/20 disabled:opacity-40 disabled:hover:bg-white/10"
                >
                  {copiedKind === kind ? (
                    <Check className="size-3.5" />
                  ) : (
                    <ClipboardCopy className="size-3.5" />
                  )}
                  {copiedKind === kind ? "Copied" : `Copy ${kind} as code`}
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(`Clear all saved ${kind} cells?`)) {
                      devMapActions.clearKind(kind);
                    }
                  }}
                  disabled={count === 0}
                  className="inline-flex items-center gap-1.5 rounded bg-white/10 px-2.5 py-1.5 text-[12px] text-white hover:bg-red-500/30 disabled:opacity-40 disabled:hover:bg-white/10"
                >
                  <Eraser className="size-3.5" />
                  Clear {kind}
                </button>
              </span>
            );
          })}
        </div>
      </section>

      {cells.length > 0 && (
        <section className="rounded-md border border-white/10 bg-white/5 p-3">
          <div className="text-[12px] font-medium text-white">Cells</div>
          <ul className="mt-2 grid grid-cols-2 gap-1 text-[11px] font-mono text-white/70">
            {cells.map((c, i) => (
              <li
                key={`${c.kind}:${c.x},${c.z}`}
                className="rounded bg-black/30 px-2 py-1"
              >
                <span
                  className={
                    c.kind === "stand" ? "text-blue-300" : "text-emerald-300"
                  }
                >
                  [{c.kind}]
                </span>{" "}
                #{i + 1} ({c.x}, {c.z}) · {((c.rotationY * 180) / Math.PI).toFixed(0)}°
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
