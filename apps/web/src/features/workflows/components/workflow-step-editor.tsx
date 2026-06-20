"use client";

// Single spawn-step row inside a workflow's step list. Stores per-row
// state up in the parent — this component is purely presentational +
// invokes callbacks on edit / reorder / remove.
//
// Reorder uses ↑↓ buttons, not drag-drop, on purpose: avoids a DnD
// library dependency for what is usually 1-5 rows.

import { ArrowDown, ArrowUp, Plus, Sparkles, Trash2 } from "lucide-react";
import type { MetaActionStep, SpawnStep } from "@occa/shared/workflows";
import { roleLabelFor } from "@occa/shared/role-catalog";
import {
  Autocomplete,
  type AutocompleteOption,
} from "@/components/ui/autocomplete";
import { Button } from "@/components/ui/button";
import type { DeploymentOption } from "../api/use-deployment-names";

interface WorkflowStepEditorProps {
  step: SpawnStep;
  index: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canRemove: boolean;
  // Suggestions for the assignee autocomplete. "human" is always
  // prepended so it appears at the top regardless of API state.
  assigneeOptions?: DeploymentOption[];
  // Ids of every step in the workflow — populates a gate's "on fail, go to"
  // target picker.
  stepIds?: string[];
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
  stepIds = [],
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: WorkflowStepEditorProps) {
  // Keep "human" at the top + dedupe against fetched agents. Agent
  // entries get a `description` showing their role label so the picker
  // reveals "Aiden Park · CEO" instead of just a name.
  const options: AutocompleteOption[] = [
    { value: "human", description: "leave unassigned" },
    ...assigneeOptions
      .filter((d) => d.name !== "human")
      .map((d) => ({
        value: d.name,
        description: d.role ? roleLabelFor(d.role) : undefined,
      })),
  ];
  const insertParentTitle = () => {
    onChange({
      ...step,
      title: `${step.title}${step.title.endsWith(" ") ? "" : " "}{{parent.title}}`,
    });
  };

  const isGate = step.kind === "gate";
  const isTool = step.kind === "tool";
  const setKind = (kind: "spawn" | "gate" | "tool") => {
    if (kind === step.kind) return;
    if (kind === "tool") {
      // A tool step is engine-executed I/O — it has no prompt, acceptance, or
      // gate target. Drop those so the YAML for a tool step stays clean.
      onChange({
        ...step,
        kind,
        prompt: undefined,
        acceptance_criteria: undefined,
        on_fail_goto: undefined,
        on_error: undefined,
      });
      return;
    }
    onChange({
      ...step,
      kind,
      // Leaving tool: drop the tool wiring so a spawn/gate step carries none.
      tool: undefined,
      action: undefined,
      input: undefined,
      // A gate is the head's decision point. Default its assignee to the
      // editorial head role when switching in, unless the author already
      // chose a role tag.
      assigned_to:
        kind === "gate" && !step.assigned_to.toLowerCase().startsWith("role:")
          ? "role:head_editorial"
          : step.assigned_to,
    });
  };

  // Tool step input map (key → literal/template). Controlled from props; new
  // rows seed a unique key so two blank keys never collapse mid-edit.
  const inputEntries = Object.entries(step.input ?? {});
  const writeInput = (entries: [string, string][]) => {
    const rec: Record<string, string> = {};
    for (const [k, v] of entries) rec[k] = v;
    onChange({ ...step, input: entries.length ? rec : undefined });
  };
  const addInput = () => {
    const keys = new Set(inputEntries.map(([k]) => k));
    let n = inputEntries.length + 1;
    while (keys.has(`field${n}`)) n += 1;
    writeInput([...inputEntries, [`field${n}`, ""]]);
  };

  return (
    <div
      className={`glass-light rounded-xl p-3 space-y-2.5 ${
        isGate
          ? "ring-1 ring-amber-300/25"
          : isTool
            ? "ring-1 ring-sky-300/25"
            : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-white/40">
            Step {index + 1}
          </span>
          <div className="flex items-center gap-0.5 rounded-lg bg-white/5 p-0.5">
            <KindButton active={!isGate && !isTool} onClick={() => setKind("spawn")}>
              Work
            </KindButton>
            <KindButton active={isGate} onClick={() => setKind("gate")}>
              Gate
            </KindButton>
            <KindButton active={isTool} onClick={() => setKind("tool")}>
              Tool
            </KindButton>
          </div>
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
        <label className="text-[10px] text-white/45">
          ID{" "}
          <span className="text-white/30">
            (optional — a gate&apos;s &quot;on fail&quot; target points at this)
          </span>
        </label>
        <input
          value={step.id ?? ""}
          onChange={(e) =>
            onChange({ ...step, id: e.target.value || undefined })
          }
          placeholder="e.g. draft"
          className="w-full glass-light rounded-lg px-3 py-2 text-xs font-mono text-white/90 placeholder:text-white/30 outline-none focus:ring-1 focus:ring-white/20"
        />
      </div>

      {isGate && (
        <div className="space-y-1.5">
          <p className="text-[10px] leading-relaxed text-amber-200/65">
            The assignee reviews the piece and emits a go / fail / kill verdict.
            Fail rewinds to the step below to revise; the run caps at 2 revisions
            before it auto-kills (set <code>max_revisions</code> in YAML).
          </p>
          <div className="space-y-1">
            <label className="text-[10px] text-white/45">On fail, go to</label>
            <select
              value={step.on_fail_goto ?? ""}
              onChange={(e) =>
                onChange({ ...step, on_fail_goto: e.target.value || undefined })
              }
              className="w-full glass-light rounded-lg px-3 py-2 text-xs text-white/90 outline-none focus:ring-1 focus:ring-white/20 cursor-pointer"
            >
              <option value="">Default (two steps back)</option>
              {stepIds
                .filter((id) => id !== step.id)
                .map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
            </select>
          </div>
        </div>
      )}

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

      {isTool ? (
        <>
          <p className="text-[10px] leading-relaxed text-sky-200/65">
            A tool step is run by the engine (no agent) as the assignee&apos;s
            role — it invokes the company tool below with the input mapping.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[10px] text-white/45">Tool</label>
              <input
                value={step.tool ?? ""}
                onChange={(e) =>
                  onChange({ ...step, tool: e.target.value || undefined })
                }
                placeholder="e.g. publish, image"
                className="w-full glass-light rounded-lg px-3 py-2 text-xs font-mono text-white/90 placeholder:text-white/30 outline-none focus:ring-1 focus:ring-white/20"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-white/45">Action</label>
              <input
                value={step.action ?? ""}
                onChange={(e) =>
                  onChange({ ...step, action: e.target.value || undefined })
                }
                placeholder="e.g. post, generate"
                className="w-full glass-light rounded-lg px-3 py-2 text-xs font-mono text-white/90 placeholder:text-white/30 outline-none focus:ring-1 focus:ring-white/20"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] text-white/45">
              Input <span className="text-white/30">(optional)</span>
            </label>
            <p className="text-[10px] leading-relaxed text-white/35">
              Map each field to a literal, or a prior step&apos;s output with{" "}
              <code>{"{{step_id.output}}"}</code> /{" "}
              <code>{"{{step_id.output.field}}"}</code>.
            </p>
            {inputEntries.map(([k, v], i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  value={k}
                  onChange={(e) =>
                    writeInput(
                      inputEntries.map((row, idx) =>
                        idx === i ? [e.target.value, row[1]] : row,
                      ),
                    )
                  }
                  placeholder="field"
                  className="w-1/3 glass-light rounded-lg px-2.5 py-2 text-xs font-mono text-white/90 placeholder:text-white/30 outline-none focus:ring-1 focus:ring-white/20"
                />
                <input
                  value={v}
                  onChange={(e) =>
                    writeInput(
                      inputEntries.map((row, idx) =>
                        idx === i ? [row[0], e.target.value] : row,
                      ),
                    )
                  }
                  placeholder="{{seo.output}}"
                  className="flex-1 glass-light rounded-lg px-2.5 py-2 text-xs font-mono text-white/90 placeholder:text-white/30 outline-none focus:ring-1 focus:ring-white/20"
                />
                <IconButton
                  label="Remove input"
                  onClick={() =>
                    writeInput(inputEntries.filter((_, idx) => idx !== i))
                  }
                  tone="danger"
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={addInput}
            >
              <Plus className="size-3" /> Add input
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-1">
            <label className="text-[10px] text-white/45">
              Prompt <span className="text-white/30">(optional)</span>
            </label>
            <textarea
              value={step.prompt ?? ""}
              onChange={(e) =>
                onChange({ ...step, prompt: e.target.value || undefined })
              }
              placeholder="Instructions for this step — what to do and what the output must look like. Leads the task body."
              rows={3}
              className="w-full glass-light rounded-lg px-3 py-2 text-xs text-white/90 leading-relaxed placeholder:text-white/30 outline-none focus:ring-1 focus:ring-white/20 resize-none"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[10px] text-white/45">
              Acceptance criteria{" "}
              <span className="text-white/30">(optional)</span>
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

          <div className="space-y-1">
            <label className="text-[10px] text-white/45">On error</label>
            <select
              value={step.on_error ?? "retry"}
              onChange={(e) =>
                onChange({
                  ...step,
                  on_error:
                    e.target.value === "retry"
                      ? undefined
                      : (e.target.value as "fail_run" | "skip"),
                })
              }
              className="w-full glass-light rounded-lg px-3 py-2 text-xs text-white/90 outline-none focus:ring-1 focus:ring-white/20 cursor-pointer"
            >
              <option value="retry">Retry up to 3x, then fail the run (default)</option>
              <option value="fail_run">Fail the run immediately</option>
              <option value="skip">Skip this step and continue</option>
            </select>
          </div>
        </>
      )}
    </div>
  );
}

// Meta-action step row — currently only `close_parent`, which auto-resolves the
// run's parent task when reached. No agent, no title/assignee; just an optional
// resolution comment.
export function MetaStepEditor({
  step,
  index,
  canMoveUp,
  canMoveDown,
  canRemove,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  step: MetaActionStep;
  index: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canRemove: boolean;
  onChange: (next: MetaActionStep) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="glass-light rounded-xl p-3 space-y-2.5 ring-1 ring-violet-300/20">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-white/40">
            Step {index + 1}
          </span>
          <span className="rounded-md bg-violet-400/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-violet-200/80">
            Close parent
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton label="Move up" disabled={!canMoveUp} onClick={onMoveUp}>
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
      <p className="text-[10px] leading-relaxed text-violet-200/60">
        Auto-resolves the parent task with a canned comment when the run reaches
        this step. No agent runs.
      </p>
      <div className="space-y-1">
        <label className="text-[10px] text-white/45">
          Comment <span className="text-white/30">(optional)</span>
        </label>
        <input
          value={step.comment ?? ""}
          onChange={(e) =>
            onChange({ ...step, comment: e.target.value || undefined })
          }
          placeholder="Resolution note left on the parent task"
          className="w-full glass-light rounded-lg px-3 py-2 text-xs text-white/90 placeholder:text-white/30 outline-none focus:ring-1 focus:ring-white/20"
        />
      </div>
    </div>
  );
}

function KindButton({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors ${
        active
          ? "bg-white/15 text-white/90"
          : "text-white/45 hover:text-white/70"
      }`}
    >
      {children}
    </button>
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
