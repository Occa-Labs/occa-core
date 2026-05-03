"use client";

import { Sparkles, Wrench, Zap, AlertTriangle } from "lucide-react";
import { AppWindow } from "@/components/ui/app-window";
import {
  CHANGELOG,
  type ChangelogEntry,
  type ChangelogTag,
} from "@/lib/changelog-data";

interface ChangelogsWindowProps {
  onClose?: () => void;
}

const TAG_META: Record<
  ChangelogTag,
  { label: string; icon: typeof Sparkles; className: string }
> = {
  feature: {
    label: "New",
    icon: Sparkles,
    className: "bg-sky-500/15 text-sky-200 border-sky-400/30",
  },
  improvement: {
    label: "Improved",
    icon: Zap,
    className: "bg-emerald-500/15 text-emerald-200 border-emerald-400/30",
  },
  fix: {
    label: "Fixed",
    icon: Wrench,
    className: "bg-amber-500/15 text-amber-200 border-amber-400/30",
  },
  breaking: {
    label: "Breaking",
    icon: AlertTriangle,
    className: "bg-red-500/15 text-red-200 border-red-400/30",
  },
};

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function ChangelogsWindow({ onClose }: ChangelogsWindowProps) {
  const latest = CHANGELOG[0];
  const subtitle = latest ? `Latest: v${latest.version}` : undefined;

  return (
    <AppWindow
      title="Changelogs"
      subtitle={subtitle}
      onClose={onClose}
      defaultSize={{
        w: Math.min(720, Math.round(window.innerWidth * 0.62)),
        h: Math.min(720, Math.round(window.innerHeight * 0.82)),
      }}
      minWidth={460}
      minHeight={380}
    >
      <div className="flex h-full flex-col">
        <div className="flex-1 overflow-y-auto">
          {CHANGELOG.length === 0 ? (
            <div className="flex items-center justify-center h-full text-white/40 text-sm">
              No changelogs yet.
            </div>
          ) : (
            <ul className="divide-y divide-white/[0.04]">
              {CHANGELOG.map((entry) => (
                <EntryRow key={entry.version} entry={entry} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </AppWindow>
  );
}

function EntryRow({ entry }: { entry: ChangelogEntry }) {
  return (
    <li className="px-5 py-4">
      <div className="flex items-baseline gap-3 mb-3">
        <span className="text-sm font-semibold text-white/90">
          v{entry.version}
        </span>
        <span className="text-[11px] text-white/40">
          {formatDate(entry.date)}
        </span>
        <span className="text-xs text-white/60 truncate">{entry.title}</span>
      </div>
      <ul className="space-y-1.5">
        {entry.items.map((item, i) => {
          const meta = TAG_META[item.tag];
          const Icon = meta.icon;
          return (
            <li key={i} className="flex items-start gap-2.5">
              <span
                className={`shrink-0 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${meta.className}`}
              >
                <Icon className="size-2.5" />
                {meta.label}
              </span>
              <p className="text-xs text-white/75 leading-relaxed">
                {item.text}
              </p>
            </li>
          );
        })}
      </ul>
    </li>
  );
}
