"use client";

// Single spawn-step row inside a workflow's step list. Stores per-row
// state up in the parent — this component is purely presentational +
// invokes callbacks on edit / reorder / remove.
//
// Reorder uses ↑↓ buttons, not drag-drop, on purpose: avoids a DnD
// library dependency for what is usually 1-5 rows.

import { ArrowDown, ArrowUp, Sparkles, Trash2 } from "lucide-react";
import type { SpawnStep } from "@occa/shared/workflows";
import { Autocomplete } from "@/components/ui/autocomplete";
import { Button } from "@/components/ui/button";

interface WorkflowStepEditorProps {
  step: SpawnStep;
  index: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canRemove: boolean;
  // Suggestions for the assignee autocomplete. "human" is always
  // prepended so it appears at the top regardless of API state.
  assigneeOptions?: string[];
  onChange: (next: SpawnStep) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}

export function WorkflowStepEditor({
  step,
  index,
  canMoveUp,
  canMoveDown,
  canRemove,
  assigneeOptions = [],
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: WorkflowStepEditorProps) {
  // Keep "human" at the top + dedupe against fetched names.
  const options = ["human", ...assigneeOptions.filter((n) => n !== "human")];
  const insertParentTitle = () => {
    onChange({
      ...step,
      title: `${step.title}${step.title.endsWith(" ") ? "" : " "}{{parent.title}}`,
    });
  };

  return (
    <div className="glass-light rounded-xl p-3 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-white/40">
          Step {index + 1}
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton
            label="Move up"
            disabled={!canMoveUp}
            onClick={onMoveUp}
          >
            <ArrowUp className="size-3.5" />
          </IconButton>
          <IconButton
            label="Move down"
            disabled={!canMoveDown}
            onClick={onMoveDown}
          >
            <ArrowDown className="size-3.5" />
          </IconButton>
          <IconButton
            label="Remove step"
            disabled={!canRemove}
            onClick={onRemove}
            tone="danger"
          >
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-[10px] text-white/45">Title</label>
        <div className="flex gap-1.5">
          <input
            value={step.title}
            onChange={(e) => onChange({ ...step, title: e.target.value })}
            placeholder="What this step does"
            className="flex-1 glass-light rounded-lg px-3 py-2 text-xs text-white/90 placeholder:text-white/30 outline-none focus:ring-1 focus:ring-white/20"
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            title="Insert {{parent.title}} variable"
            onClick={insertParentTitle}
          >
            <Sparkles className="size-3" /> parent.title
          </Button>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-[10px] text-white/45">Assignee</label>
        <Autocomplete
          value={step.assigned_to}
          onChange={(v) => onChange({ ...step, assigned_to: v })}
          options={options}
          placeholder="human, or an agent name (e.g. ResearchBot)"
        />
      </div>

      <div className="space-y-1">
        <label className="text-[10px] text-white/45">
          Acceptance criteria <span className="text-white/30">(optional)</span>
        </label>
        <textarea
          value={step.acceptance_criteria ?? ""}
          onChange={(e) =>
            onChange({
              ...step,
              acceptance_criteria: e.target.value || undefined,
            })
          }
          placeholder="What does done look like for this step?"
          rows={2}
          className="w-full glass-light rounded-lg px-3 py-2 text-xs text-white/90 leading-relaxed placeholder:text-white/30 outline-none focus:ring-1 focus:ring-white/20 resize-none"
        />
      </div>
    </div>
  );
}

function IconButton({
  children,
  onClick,
  disabled,
  label,
  tone = "neutral",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
  tone?: "neutral" | "danger";
}) {
  const base =
    "p-1 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed";
  const active =
    tone === "danger"
      ? "text-red-300/70 hover:text-red-200 hover:bg-red-500/15"
      : "text-white/55 hover:text-white/90 hover:bg-white/10";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`${base} ${active}`}
    >
      {children}
    </button>
  );
}
