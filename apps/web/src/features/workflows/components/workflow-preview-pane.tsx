"use client";

// Live preview that mirrors the form state in plain English. Sits next
// to the form editor so the user sees what the workflow will actually
// do as they type — converts an abstract YAML schema into the question
// "given a parent task, what spawns?".
//
// Renders trigger summary + ordered task list. Cap warnings appear when
// steps exceed max_children so users notice clipping early.

import { ListOrdered, AlertTriangle } from "lucide-react";
import type { WorkflowFormState } from "./workflow-form-editor";

const TASK_TYPE_LABEL: Record<string, string> = {
  feature: "Feature",
  bug: "Bug",
  research: "Research",
  docs: "Docs",
  chore: "Chore",
  other: "Other",
};

// Hardcoded mirror of LIMITS.TASK_EMIT_MAX_CHILDREN; the server caps
// spawning at 3 per workflow run regardless of step count, and the
// preview surfaces that to the user so over-long step lists get a
// visible "only the first 3 fire" hint.
const MAX_CHILDREN_HINT = 3;

const EXAMPLE_PARENT_TITLE = "Parent task title";

export function WorkflowPreviewPane({ state }: { state: WorkflowFormState }) {
  return (
    <div className="space-y-3 text-xs">
      <Header />
      <TriggerLine state={state} />
      <LinearPreview state={state} />
    </div>
  );
}

function Header() {
  return (
    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-white/45">
      <span>Preview</span>
      <span className="text-white/25">— what this workflow will do</span>
    </div>
  );
}

function TriggerLine({ state }: { state: WorkflowFormState }) {
  const typeLabel = TASK_TYPE_LABEL[state.taskType] ?? state.taskType;
  if (state.execution === "sequential") {
    return (
      <div className="space-y-1">
        <div className="text-[10px] text-white/45">Starts when</div>
        <div className="text-white/80">
          a routine bound to this workflow fires. Steps then run{" "}
          <span className="text-white/95 font-medium">in order</span>, one at a
          time.
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-white/45">Fires when</div>
      <div className="text-white/80">
        a <span className="text-white/95 font-medium">{typeLabel}</span> task
        moves to <span className="text-white/95 font-medium">Done</span>.
      </div>
    </div>
  );
}

function LinearPreview({ state }: { state: WorkflowFormState }) {
  const validSteps = state.steps.filter((s) =>
    "title" in s ? s.title.trim().length > 0 : true,
  );
  const sequential = state.execution === "sequential";
  // The 3-children-per-run cap is a fan-out (parallel) concern. Sequential
  // runs advance one step at a time, so the cap warning does not apply.
  const overflow = sequential
    ? 0
    : Math.max(0, validSteps.length - MAX_CHILDREN_HINT);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[10px] text-white/45">
        <ListOrdered className="size-3" />
        {sequential ? "Then runs" : "Then spawns"} ({validSteps.length} step
        {validSteps.length === 1 ? "" : "s"})
      </div>
      {validSteps.length === 0 ? (
        <EmptyHint>Add at least one step to see the spawn list.</EmptyHint>
      ) : (
        <ol className="space-y-1.5">
          {validSteps.map((step, i) => (
            <li
              key={i}
              className={`pl-3 border-l ${
                sequential || i < MAX_CHILDREN_HINT
                  ? "border-emerald-500/40"
                  : "border-amber-500/30 opacity-60"
              }`}
            >
              <div className="text-white/85 leading-snug">
                {"title" in step
                  ? renderTitle(step.title)
                  : "Close the parent task"}
              </div>
              <div className="text-[10px] text-white/40">
                →{" "}
                {"title" in step
                  ? step.assigned_to || "(unassigned)"
                  : "(auto-resolve)"}
              </div>
            </li>
          ))}
        </ol>
      )}
      {overflow > 0 && (
        <CapWarning>
          Only the first {MAX_CHILDREN_HINT} steps will spawn each run; the
          remaining {overflow} log as skipped.
        </CapWarning>
      )}
    </div>
  );
}

function renderTitle(template: string): string {
  return template
    .replace(/\{\{\s*parent\.title\s*\}\}/g, EXAMPLE_PARENT_TITLE)
    .trim();
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] text-white/35 italic">{children}</div>
  );
}

function CapWarning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-1.5 text-[10px] text-amber-300/85 bg-amber-500/8 border border-amber-500/15 rounded px-2 py-1.5">
      <AlertTriangle className="size-3 shrink-0 mt-0.5" />
      <div>{children}</div>
    </div>
  );
}
