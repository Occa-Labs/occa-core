"use client";

// Form-based editor for linear workflows. Replaces the YAML textarea
// when the user picks a template (or edits an existing workflow that
// parses cleanly). On submit we serialize back to YAML and POST through
// the existing create/patch endpoint — no API changes needed.

import { useState } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import {
  serializeWorkflowToYaml,
  type LinearWorkflowDefinition,
  type MetaActionStep,
  type SpawnStep,
  type WorkflowDefinition,
  type WorkflowStep,
} from "@occa/shared/workflows";
import { TASK_TYPES, type TaskType } from "@occa/shared/types";
import { Button } from "@/components/ui/button";
import {
  useDeploymentNames,
  type DeploymentOption,
} from "../api/use-deployment-names";
import { MetaStepEditor, WorkflowStepEditor } from "./workflow-step-editor";

// A workflow's per-run caps (all optional). Mirrors the YAML `caps` block.
export interface WorkflowCaps {
  max_revisions?: number;
  max_depth?: number;
  max_children?: number;
}

export interface WorkflowFormState {
  yamlId: string;
  name: string;
  description: string;
  // parallel = fan out every step at once when a matching task completes.
  // sequential = run steps one at a time under a shared parent, started by
  // a routine (the news pipeline). Preserved on edit so the form never
  // silently downgrades a sequential workflow to parallel on save.
  execution: "parallel" | "sequential";
  taskType: string;
  // Union: ordinary spawn/gate/tool steps plus meta-action steps
  // (close_parent), so the form round-trips every step kind the YAML allows.
  steps: WorkflowStep[];
  caps?: WorkflowCaps;
}

const EMPTY_STEP: SpawnStep = {
  kind: "spawn",
  title: "",
  assigned_to: "human",
};

const EMPTY_META_STEP: MetaActionStep = {
  action: "close_parent",
};

function isSpawnFormStep(s: WorkflowStep): s is SpawnStep {
  return "title" in s;
}

// Build form state from an existing typed definition.
export function formStateFromDefinition(
  def: WorkflowDefinition,
): WorkflowFormState {
  return {
    yamlId: def.id,
    name: def.name,
    description: def.description ?? "",
    execution: def.execution,
    taskType: def.trigger.match.task_type,
    steps: def.steps.map((s) =>
      isSpawnFormStep(s)
        ? {
            kind: s.kind,
            id: s.id,
            title: s.title,
            assigned_to: s.assigned_to,
            prompt: s.prompt,
            acceptance_criteria: s.acceptance_criteria,
            on_fail_goto: s.on_fail_goto,
            on_error: s.on_error,
            tool: s.tool,
            action: s.action,
            input: s.input,
          }
        : { action: s.action, comment: s.comment },
    ),
    caps: def.caps,
  };
}

// Serialize form state to YAML. Caller passes the result straight into
// the existing create/patch payload.
export function formStateToYaml(state: WorkflowFormState): string {
  const def: LinearWorkflowDefinition = {
    id: state.yamlId.trim(),
    name: state.name.trim(),
    execution: state.execution,
    ...(state.description.trim()
      ? { description: state.description.trim() }
      : {}),
    trigger: {
      when: "task.completed",
      match: { task_type: state.taskType },
    },
    steps: state.steps.map((s) =>
      isSpawnFormStep(s)
        ? {
            // Preserve kind + tool wiring on round-trip so editing a gate or
            // tool workflow via the form never silently strips a step back to a
            // plain spawn (or drops a tool step's tool/action/input).
            kind: s.kind,
            ...(s.id ? { id: s.id } : {}),
            title: s.title,
            assigned_to: s.assigned_to,
            ...(s.prompt ? { prompt: s.prompt } : {}),
            ...(s.acceptance_criteria
              ? { acceptance_criteria: s.acceptance_criteria }
              : {}),
            ...(s.on_fail_goto ? { on_fail_goto: s.on_fail_goto } : {}),
            ...(s.on_error ? { on_error: s.on_error } : {}),
            ...(s.tool ? { tool: s.tool } : {}),
            ...(s.action ? { action: s.action } : {}),
            ...(s.input && Object.keys(s.input).length
              ? { input: s.input }
              : {}),
          }
        : { action: s.action, ...(s.comment ? { comment: s.comment } : {}) },
    ),
    ...(capsForYaml(state.caps) ? { caps: capsForYaml(state.caps)! } : {}),
  };
  return serializeWorkflowToYaml(def);
}

// Keep only the caps the user actually set — an all-undefined caps block should
// not emit `caps: {}` into the YAML.
function capsForYaml(caps?: WorkflowCaps): WorkflowCaps | null {
  if (!caps) return null;
  const out: WorkflowCaps = {};
  if (typeof caps.max_revisions === "number")
    out.max_revisions = caps.max_revisions;
  if (typeof caps.max_depth === "number") out.max_depth = caps.max_depth;
  if (typeof caps.max_children === "number")
    out.max_children = caps.max_children;
  return Object.keys(out).length ? out : null;
}

interface WorkflowFormEditorProps {
  state: WorkflowFormState;
  onChange: (next: WorkflowFormState) => void;
  // When true, yamlId field is read-only (editing an existing workflow
  // — id is the immutable slug used as a stable handle).
  lockYamlId?: boolean;
}

export function WorkflowFormEditor({
  state,
  onChange,
  lockYamlId,
}: WorkflowFormEditorProps) {
  const { names: assigneeOptions } = useDeploymentNames();
  return (
    <div className="space-y-5">
      <BasicsSection state={state} onChange={onChange} lockYamlId={lockYamlId} />
      <TriggerSection state={state} onChange={onChange} />
      <StepsSection
        state={state}
        onChange={onChange}
        assigneeOptions={assigneeOptions}
      />
      <CapsSection state={state} onChange={onChange} />
      <AdvancedSection state={state} />
    </div>
  );
}

// Collapsible bottom-of-form panel for power users — shows the YAML
// the form will serialize to, without forcing a switch to "Edit raw
// YAML" (which would discard form state on the way back). Read-only
// so any edits stay in the form fields where validation can react to
// them in real time.
function AdvancedSection({ state }: { state: WorkflowFormState }) {
  const [open, setOpen] = useState(false);
  const yaml = open ? formStateToYaml(state) : "";
  return (
    <div className="space-y-2 pt-2 border-t border-white/8">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-white/45 hover:text-white/75"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        Advanced — raw YAML preview
      </button>
      {open && (
        <pre className="glass-light rounded-lg px-3 py-2 text-[11px] font-mono leading-relaxed text-white/75 overflow-x-auto whitespace-pre">
          {yaml}
        </pre>
      )}
    </div>
  );
}

function BasicsSection({
  state,
  onChange,
  lockYamlId,
}: {
  state: WorkflowFormState;
  onChange: (next: WorkflowFormState) => void;
  lockYamlId?: boolean;
}) {
  return (
    <Section title="Basics">
      <Field label="Workflow id">
        <input
          value={state.yamlId}
          onChange={(e) =>
            onChange({ ...state, yamlId: slugify(e.target.value) })
          }
          disabled={lockYamlId}
          placeholder="my-workflow"
          className="w-full glass-light rounded-lg px-3 py-2 text-xs font-mono text-white/90 placeholder:text-white/30 outline-none focus:ring-1 focus:ring-white/20 disabled:opacity-60 disabled:cursor-not-allowed"
        />
        <Hint>
          Lowercase letters, numbers, and hyphens. Used as a stable
          handle in audit logs.
        </Hint>
      </Field>
      <Field label="Name">
        <input
          value={state.name}
          onChange={(e) => onChange({ ...state, name: e.target.value })}
          placeholder="Blog Post Pipeline"
          className="w-full glass-light rounded-lg px-3 py-2 text-xs text-white/90 placeholder:text-white/30 outline-none focus:ring-1 focus:ring-white/20"
        />
      </Field>
      <Field label="Description (optional)">
        <input
          value={state.description}
          onChange={(e) =>
            onChange({ ...state, description: e.target.value })
          }
          placeholder="One-line summary of when this fires."
          className="w-full glass-light rounded-lg px-3 py-2 text-xs text-white/90 placeholder:text-white/30 outline-none focus:ring-1 focus:ring-white/20"
        />
      </Field>
      <Field label="Mode">
        <select
          value={state.execution}
          onChange={(e) =>
            onChange({
              ...state,
              execution: e.target.value as "parallel" | "sequential",
            })
          }
          className="w-full glass-light rounded-lg px-3 py-2 text-xs text-white/90 outline-none focus:ring-1 focus:ring-white/20 cursor-pointer"
        >
          <option value="parallel">Parallel — spawn every step at once</option>
          <option value="sequential">
            Sequential — one step at a time (pipeline)
          </option>
        </select>
        <Hint>
          {state.execution === "sequential"
            ? "Steps run in order, each waiting for the previous to finish. Started by a routine, not by a task completing."
            : "All steps spawn together when a matching task completes."}
        </Hint>
      </Field>
    </Section>
  );
}

function TriggerSection({
  state,
  onChange,
}: {
  state: WorkflowFormState;
  onChange: (next: WorkflowFormState) => void;
}) {
  // Sequential pipelines are started by a routine, so the task_type
  // trigger never fires them. Show the field but make clear it is unused
  // rather than letting it imply the pipeline auto-fires on completions.
  if (state.execution === "sequential") {
    return (
      <Section title="Trigger">
        <div className="glass-light rounded-lg px-3 py-2.5 text-[11px] leading-relaxed text-white/55">
          Sequential pipelines start from a routine bound to this workflow,
          not from a task completing. The task type trigger below does not
          apply.
        </div>
      </Section>
    );
  }
  return (
    <Section title="Trigger">
      <Field label="When">
        <ReadOnlyValue>
          task.completed
          <span className="text-white/30 font-normal">
            {" "}— fires after a task moves to done
          </span>
        </ReadOnlyValue>
      </Field>
      <Field label="On task type">
        <TaskTypeSelect
          value={state.taskType}
          onChange={(v) => onChange({ ...state, taskType: v })}
        />
        <Hint>Workflow fires only for completed tasks of this type.</Hint>
      </Field>
    </Section>
  );
}

function StepsSection({
  state,
  onChange,
  assigneeOptions,
}: {
  state: WorkflowFormState;
  onChange: (next: WorkflowFormState) => void;
  assigneeOptions: DeploymentOption[];
}) {
  return (
    <Section title="Steps">
      <p className="text-[11px] text-white/45">
        Each step spawns one child task when the parent completes.
        Maximum 3 children fire per run; extra steps log as skipped.
      </p>
      <div className="space-y-2.5">
        {state.steps.map((step, i) => {
          const replace = (next: WorkflowStep) => {
            const steps = [...state.steps];
            steps[i] = next;
            onChange({ ...state, steps });
          };
          const moveUp = () => {
            if (i === 0) return;
            const steps = [...state.steps];
            [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
            onChange({ ...state, steps });
          };
          const moveDown = () => {
            if (i === state.steps.length - 1) return;
            const steps = [...state.steps];
            [steps[i], steps[i + 1]] = [steps[i + 1], steps[i]];
            onChange({ ...state, steps });
          };
          const remove = () => {
            if (state.steps.length <= 1) return;
            onChange({
              ...state,
              steps: state.steps.filter((_, idx) => idx !== i),
            });
          };
          const shared = {
            index: i,
            canMoveUp: i > 0,
            canMoveDown: i < state.steps.length - 1,
            canRemove: state.steps.length > 1,
            onMoveUp: moveUp,
            onMoveDown: moveDown,
            onRemove: remove,
          };
          return isSpawnFormStep(step) ? (
            <WorkflowStepEditor
              key={i}
              step={step}
              assigneeOptions={assigneeOptions}
              stepIds={state.steps
                .filter(isSpawnFormStep)
                .map((s) => s.id)
                .filter((id): id is string => !!id)}
              onChange={replace}
              {...shared}
            />
          ) : (
            <MetaStepEditor key={i} step={step} onChange={replace} {...shared} />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() =>
            onChange({ ...state, steps: [...state.steps, { ...EMPTY_STEP }] })
          }
          disabled={state.steps.length >= 10}
        >
          <Plus className="size-3" /> Add step
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() =>
            onChange({
              ...state,
              steps: [...state.steps, { ...EMPTY_META_STEP }],
            })
          }
          disabled={state.steps.length >= 10}
          title="A meta step that auto-resolves the parent task when reached"
        >
          <Plus className="size-3" /> Add close-parent
        </Button>
      </div>
    </Section>
  );
}

function CapsSection({
  state,
  onChange,
}: {
  state: WorkflowFormState;
  onChange: (next: WorkflowFormState) => void;
}) {
  const caps = state.caps ?? {};
  const setCap = (key: keyof WorkflowCaps, raw: string) => {
    const trimmed = raw.trim();
    const value = trimmed === "" ? undefined : Number(trimmed);
    onChange({
      ...state,
      caps: {
        ...caps,
        [key]: value !== undefined && Number.isFinite(value) ? value : undefined,
      },
    });
  };
  return (
    <Section title="Limits (optional)">
      <div className="grid grid-cols-3 gap-2">
        <CapField
          label="Max revisions"
          hint="0–5"
          value={caps.max_revisions}
          onChange={(r) => setCap("max_revisions", r)}
        />
        <CapField
          label="Max depth"
          hint="1–5"
          value={caps.max_depth}
          onChange={(r) => setCap("max_depth", r)}
        />
        <CapField
          label="Max children"
          hint="1–10"
          value={caps.max_children}
          onChange={(r) => setCap("max_children", r)}
        />
      </div>
      <Hint>
        Gate fail rewinds up to max revisions before the run auto-kills.
        Depth and children bound parallel fan-out.
      </Hint>
    </Section>
  );
}

function CapField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value?: number;
  onChange: (raw: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] text-white/45">{label}</label>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hint}
        className="w-full glass-light rounded-lg px-3 py-2 text-xs text-white/90 placeholder:text-white/30 outline-none focus:ring-1 focus:ring-white/20"
      />
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      <h4 className="text-[10px] uppercase tracking-wider text-white/45">
        {title}
      </h4>
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] text-white/45">{label}</label>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] text-white/35 leading-relaxed">{children}</div>
  );
}

function ReadOnlyValue({ children }: { children: React.ReactNode }) {
  return (
    <div className="glass-light rounded-lg px-3 py-2 text-xs text-white/70 font-mono">
      {children}
    </div>
  );
}

const TASK_TYPE_LABELS: Record<TaskType, string> = {
  feature: "Feature",
  bug: "Bug",
  research: "Research",
  docs: "Docs",
  chore: "Chore",
  other: "Other",
};

function TaskTypeSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full glass-light rounded-lg px-3 py-2 text-xs text-white/90 placeholder:text-white/30 outline-none focus:ring-1 focus:ring-white/20"
    >
      {TASK_TYPES.map((t) => (
        <option key={t} value={t} className="bg-neutral-900">
          {TASK_TYPE_LABELS[t]}
        </option>
      ))}
    </select>
  );
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
}
