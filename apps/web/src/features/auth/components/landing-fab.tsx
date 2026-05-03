"use client";

import { useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { specularStyle, surface } from "@/components/ui/tokens";
import { cn } from "@/lib/utils";

const ITEMS = [
  {
    id: "company",
    label: "Your Company",
    subtitle: "Operate your AI agent labor force",
    icon: "business-outline",
    comingSoon: true,
  },
  {
    id: "agent-labor",
    label: "Agent Labor",
    subtitle: "Engage specialized agents on contract",
    icon: "star-outline",
    comingSoon: true,
  },
  {
    id: "company-marketplace",
    label: "Company Marketplace",
    subtitle: "Skip the build. Deploy proven templates.",
    icon: "trending-up-outline",
    comingSoon: true,
  },
  {
    id: "company-browser",
    label: "Company Browser",
    subtitle: "See AI companies in action—on-chain",
    icon: "globe-outline",
    comingSoon: true,
  },
  {
    id: "agent-browser",
    label: "Agent Browser",
    subtitle: "Discover specialized AI agents",
    icon: "people-outline",
    comingSoon: true,
  },
  {
    id: "docs",
    label: "Documentation",
    subtitle: "Build with OCCA",
    icon: "book-outline",
    comingSoon: true,
  },
] as const;

export function LandingFab() {
  const [open, setOpen] = useState(false);
  const fabRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      {/* Invisible backdrop to close on outside click */}
      {open && (
        <div className="fixed inset-0 z-49" onClick={() => setOpen(false)} />
      )}

      <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
        {/* Menu panel — anchors above the FAB */}
        {open && (
          <Card
            variant="elevated"
            padding="none"
            className="relative w-104 overflow-hidden rounded-3xl p-3"
          >
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-px"
              style={specularStyle}
            />

            <div className="px-2 pb-2.5 pt-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-white/35 select-none">
                OCCA OS
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {ITEMS.map(({ id, label, subtitle, icon }) => (
                <Card
                  key={id}
                  variant="recessed"
                  padding="md"
                  className="h-32 cursor-not-allowed rounded-[1.35rem] p-4 opacity-60"
                >
                  <div className="flex h-full flex-col justify-between">
                    <div className="flex items-start justify-between">
                      <div className="flex size-9 items-center justify-center rounded-xl bg-white shadow-[0_1px_0_rgba(255,255,255,0.45)_inset,0_8px_20px_rgba(0,0,0,0.14)]">
                        <ion-icon
                          name={icon}
                          style={{ fontSize: "18px", color: "#000" }}
                        />
                      </div>
                      <span className="rounded-full border border-white/10 bg-white/6 px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.12em] text-white/55 select-none">
                        Soon
                      </span>
                    </div>

                    <div className="space-y-1">
                      <p className="text-[12.5px] font-semibold leading-[1.2] text-white/90">
                        {label}
                      </p>
                      <p className="line-clamp-2 text-[10.5px] leading-[1.4] text-white/45">
                        {subtitle}
                      </p>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </Card>
        )}

        {/* FAB button */}
        <button
          ref={fabRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
          className={cn(
            "flex h-14 w-14 items-center justify-center rounded-full border-white/12 shadow-[0_14px_34px_rgba(0,0,0,0.22)] transition-all duration-200 hover:scale-[1.03] active:scale-95 select-none",
            open ? "text-white" : "text-white/75 hover:text-white",
          )}
          style={{
            ...surface.base,
            background: open
              ? "rgba(26, 26, 32, 0.94)"
              : surface.base.background,
          }}
        >
          <ion-icon
            name={open ? "close-outline" : "grid-outline"}
            style={{
              fontSize: "22px",
              color: open ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.75)",
            }}
          />
        </button>
      </div>
    </>
  );
}
