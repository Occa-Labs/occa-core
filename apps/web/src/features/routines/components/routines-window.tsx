"use client";

// Routines window — per-company scheduled agent wake-ups. Sidebar list +
// detail pane; "New" opens a create modal, "Edit" opens the same form
// prefilled. "Run now" marks the routine's cron triggers due so the
// worker scheduler fires it on its next tick.

import { useMemo, useState } from "react";
import { CalendarClock, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { RoutineDTO } from "@occa/shared/types";
import { AppWindow } from "@/components/ui/app-window";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Modal } from "@/components/ui/modal";
import { SectionLabel } from "@/components/ui/section-label";
import { ApiError } from "@/lib/api";
import { useRoutines } from "../api/use-routines";
import { useWorkflowOptions } from "../api/use-workflow-options";
import {
  type AgentOption,
  RoutineForm,
  type RoutineFormValues,
} from "./routine-form";

// Per-field max-length budget for the create/update routine bodies.
// Mirrors `LIMITS.DESCRIPTION_LONG` (8000) and `LIMITS.NAME` (200) on
// the server so the user-facing message can show "X / Y chars" without
// re-fetching server config.
const FIELD_LIMITS_HINT: Record<string, string> = {
  description: "max 8000 characters",
  title: "max 200 characters",
};

// Convert an API error into a one-line message naming the failing
// field(s). Falls back to a code-only line if the server sent no
// detail. Server returns `{ error, detail: parsed.error.flatten() }`
// where detail = { formErrors: string[], fieldErrors: Record<string,
// string[]> } — both of which we want to surface verbatim, not collapse
// into a generic "check the fields" string.
function formatRoutineSaveError(err: unknown, action: "create" | "save"): string {
  const verb = action === "create" ? "create" : "save";
  if (!(err instanceof ApiError)) return `Could not ${verb} the routine.`;

  const body = err.body as
    | {
        error?: string;
        detail?: {
          formErrors?: string[];
          fieldErrors?: Record<string, string[]>;
        };
      }
    | null
    | undefined;
  const code = body?.error;

  const fieldErrors = body?.detail?.fieldErrors ?? {};
  const fieldLines = Object.entries(fieldErrors)
    .flatMap(([field, msgs]) =>
      msgs.map((m) => {
        const hint = FIELD_LIMITS_HINT[field];
        const tail = hint ? ` (${hint})` : "";
        return `${field}: ${m}${tail}`;
      }),
    );
  const formLines = body?.detail?.formErrors ?? [];
  const lines = [...formLines, ...fieldLines];
  if (lines.length > 0) {
    return `Could not ${verb} the routine — ${lines.join("; ")}`;
  }

  // Known non-validation codes the routine routes can return.
  if (code === "agent_not_found") {
    return "Could not " + verb + " the routine — the selected assignee no longer exists.";
  }
  if (code === "no_company") {
    return "Could not " + verb + " the routine — no active company on this account.";
  }
  return `Could not ${verb} the routine (${code ?? `HTTP ${err.status}`}).`;
}

interface RoutinesWindowProps {
  agents: AgentOption[];
  onClose?: () => void;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A routine → the form's prefill shape (edit mode). */
function toFormValues(r: RoutineDTO): RoutineFormValues {
  const cron = r.triggers.find((t) => t.kind === "cron");
  return {
    title: r.title,
    description: r.description ?? undefined,
    assigneeAgentId: r.assigneeAgentId ?? "",
    cronExpression: cron?.cronExpression ?? "0 * * * *",
    timezone: cron?.timezone ?? "UTC",
    workflowYamlId: r.workflowYamlId ?? undefined,
  };
}

export function RoutinesWindow({ agents, onClose }: RoutinesWindowProps) {
  const {
    routines,
    loading,
    error,
    create,
    patch,
    patchTrigger,
    createTrigger,
    remove,
    run,
    reload,
  } = useRoutines(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RoutineDTO | null>(null);
  // Workflow options for the form's pipeline picker — fetched only while
  // the create/edit modal is open.
  const { workflows: workflowOptions } = useWorkflowOptions(
    creating || editing !== null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Per-routine "Run now" state so the button can report progress.
  const [runState, setRunState] = useState<
    Record<string, "running" | "fired">
  >({});

  const selected = useMemo(
    () => routines.find((r) => r.id === selectedId) ?? null,
    [routines, selectedId],
  );

  const agentName = (id: string | null): string =>
    agents.find((a) => a.id === id)?.name ?? "Unassigned";

  const openCreate = () => {
    setFormError(null);
    setCreating(true);
  };

  const openEdit = (r: RoutineDTO) => {
    setFormError(null);
    setEditing(r);
  };

  const closeForm = () => {
    setCreating(false);
    setEditing(null);
  };

  const handleCreate = async (v: RoutineFormValues) => {
    setSubmitting(true);
    setFormError(null);
    try {
      const routine = await create({
        title: v.title,
        description: v.description,
        assigneeAgentId: v.assigneeAgentId,
        workflowYamlId: v.workflowYamlId,
        triggers: [
          {
            kind: "cron",
            cronExpression: v.cronExpression,
            timezone: v.timezone,
            enabled: true,
          },
        ],
      });
      setCreating(false);
      setSelectedId(routine.id);
    } catch (err) {
      setFormError(formatRoutineSaveError(err, "create"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async (v: RoutineFormValues) => {
    if (!editing) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await patch(editing.id, {
        title: v.title,
        description: v.description,
        assigneeAgentId: v.assigneeAgentId,
        workflowYamlId: v.workflowYamlId ?? "",
      });
      const cron = editing.triggers.find((t) => t.kind === "cron");
      if (cron) {
        await patchTrigger(editing.id, cron.id, {
          cronExpression: v.cronExpression,
          timezone: v.timezone,
        });
      } else {
        await createTrigger(editing.id, {
          kind: "cron",
          cronExpression: v.cronExpression,
          timezone: v.timezone,
          enabled: true,
        });
      }
      await reload();
      setEditing(null);
    } catch (err) {
      setFormError(formatRoutineSaveError(err, "save"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRun = async (id: string) => {
    setRunState((s) => ({ ...s, [id]: "running" }));
    const ok = await run(id);
    setRunState((s) => ({ ...s, [id]: ok ? "fired" : "running" }));
  };

  const handleTogglePause = async (routine: RoutineDTO) => {
    const nextStatus = routine.status === "active" ? "paused" : "active";
    try {
      await patch(routine.id, { status: nextStatus });
    } catch (err) {
      // Surface failure inline so users know the toggle was rejected;
      // the routine card still shows its old state because patch threw
      // before mutating local routines state.
      const msg = err instanceof ApiError ? `(${err.status})` : "";
      setFormError(`Could not change routine status ${msg}`.trim());
    }
  };

  const handleDelete = async (id: string) => {
    const ok = await remove(id);
    if (ok && selectedId === id) setSelectedId(null);
  };

  return (
    <>
      <AppWindow
        title="Routines"
        subtitle={`${routines.length} routine${routines.length !== 1 ? "s" : ""}`}
        onClose={onClose}
        defaultSize={{
          w: Math.min(940, Math.round(window.innerWidth * 0.8)),
          h: Math.min(640, Math.round(window.innerHeight * 0.82)),
        }}
        minWidth={680}
        minHeight={420}
      >
        <div className="flex h-full overflow-hidden">
          {/* Sidebar */}
          <div className="w-60 shrink-0 flex flex-col border-r border-white/8">
            <div className="flex items-center justify-between px-3 py-3">
              <SectionLabel>Routines</SectionLabel>
              <Button variant="ghost" size="sm" onClick={openCreate}>
                <Plus className="size-3.5" />
                New
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-2 flex flex-col gap-1">
              {routines.map((r) => (
                <RoutineRow
                  key={r.id}
                  routine={r}
                  assignee={agentName(r.assigneeAgentId)}
                  active={selectedId === r.id}
                  onClick={() => setSelectedId(r.id)}
                />
              ))}
              {!loading && routines.length === 0 && (
                <p className="text-[12px] text-white/30 px-2 py-3">
                  No routines yet.
                </p>
              )}
            </div>
          </div>

          {/* Detail pane */}
          <div className="flex-1 min-w-0 overflow-y-auto">
            {loading ? (
              <LoadingState message="Loading routines…" />
            ) : selected ? (
              <RoutineDetail
                routine={selected}
                assignee={agentName(selected.assigneeAgentId)}
                runState={runState[selected.id]}
                onRun={() => handleRun(selected.id)}
                onTogglePause={() => handleTogglePause(selected)}
                onEdit={() => openEdit(selected)}
                onDelete={() => handleDelete(selected.id)}
              />
            ) : (
              <EmptyState
                icon={<CalendarClock />}
                title="No routine selected"
                description={
                  error
                    ? `Failed to load: ${error}`
                    : "Pick a routine, or create one to schedule an agent."
                }
                action={
                  <Button variant="primary" size="sm" onClick={openCreate}>
                    <Plus className="size-3.5" />
                    New routine
                  </Button>
                }
              />
            )}
          </div>
        </div>
      </AppWindow>

      <Modal
        open={creating || editing !== null}
        onClose={closeForm}
        title={editing ? "Edit routine" : "New routine"}
      >
        <RoutineForm
          key={editing?.id ?? "new"}
          agents={agents}
          workflows={workflowOptions}
          initial={editing ? toFormValues(editing) : undefined}
          submitting={submitting}
          error={formError}
          onSubmit={editing ? handleEdit : handleCreate}
          onCancel={closeForm}
        />
      </Modal>
    </>
  );
}

// ── Sidebar row ──────────────────────────────────────────────────────────────

function RoutineRow({
  routine,
  assignee,
  active,
  onClick,
}: {
  routine: RoutineDTO;
  assignee: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col gap-0.5 rounded-xl px-3 py-2 text-left cursor-pointer transition-colors ${
        active ? "bg-white/10" : "hover:bg-white/5"
      }`}
    >
      <span className="text-[13px] text-white/85 font-medium truncate">
        {routine.title}
      </span>
      <span className="text-[11px] text-white/35 truncate">{assignee}</span>
    </button>
  );
}

// ── Detail pane ──────────────────────────────────────────────────────────────

function RoutineDetail({
  routine,
  assignee,
  runState,
  onRun,
  onTogglePause,
  onEdit,
  onDelete,
}: {
  routine: RoutineDTO;
  assignee: string;
  runState: "running" | "fired" | undefined;
  onRun: () => void;
  onTogglePause: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const cronTrigger = routine.triggers.find((t) => t.kind === "cron");
  const isPaused = routine.status === "paused";

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight text-white/90 truncate">
            {routine.title}
          </h2>
          <p className="text-[12px] text-white/40 mt-0.5">
            Assigned to {assignee}
          </p>
        </div>
        <Badge variant={routine.status === "active" ? "success" : "muted"}>
          {routine.status}
        </Badge>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={onRun}
          disabled={runState === "running" || isPaused}
          title={isPaused ? "Resume the routine before firing manually" : undefined}
        >
          <Play className="size-3.5" />
          {runState === "running" ? "Firing…" : "Run now"}
        </Button>
        <Button variant="secondary" size="sm" onClick={onTogglePause}>
          {isPaused ? (
            <>
              <Play className="size-3.5" />
              Resume
            </>
          ) : (
            <>
              <Pause className="size-3.5" />
              Pause
            </>
          )}
        </Button>
        <Button variant="secondary" size="sm" onClick={onEdit}>
          <Pencil className="size-3.5" />
          Edit
        </Button>
        <Button variant="danger" size="sm" onClick={onDelete}>
          <Trash2 className="size-3.5" />
          Delete
        </Button>
      </div>

      {runState === "fired" && (
        <p className="text-[12px] text-emerald-300/80">
          Fired — the scheduler picks it up within ~30 seconds.
        </p>
      )}

      {routine.workflowYamlId && (
        <div>
          <SectionLabel>Workflow</SectionLabel>
          <div className="mt-1.5 flex flex-col gap-1 text-[12px] text-white/55">
            <span>
              Runs the pipeline{" "}
              <code className="font-mono text-white/75">
                {routine.workflowYamlId}
              </code>{" "}
              on each fire.
            </span>
            <span className="text-white/35">
              The mandate below is bypassed while a workflow is bound.
            </span>
          </div>
        </div>
      )}

      <div>
        <SectionLabel>Mandate</SectionLabel>
        <p className="text-[13px] text-white/70 mt-1.5 whitespace-pre-wrap leading-relaxed">
          {routine.description?.trim() || "No mandate set."}
        </p>
      </div>

      <div>
        <SectionLabel>Schedule</SectionLabel>
        {cronTrigger ? (
          <div className="mt-1.5 flex flex-col gap-1 text-[12px] text-white/55">
            <span>
              Cron{" "}
              <code className="font-mono text-white/75">
                {cronTrigger.cronExpression}
              </code>
              {cronTrigger.timezone ? ` · ${cronTrigger.timezone}` : ""}
            </span>
            <span>Next run: {fmtTime(cronTrigger.nextRunAt)}</span>
            <span>Last fired: {fmtTime(cronTrigger.lastFiredAt)}</span>
          </div>
        ) : (
          <p className="text-[12px] text-white/35 mt-1.5">No cron trigger.</p>
        )}
      </div>

      <div>
        <SectionLabel>Activity</SectionLabel>
        <div className="mt-1.5 flex flex-col gap-1 text-[12px] text-white/55">
          <span>Last triggered: {fmtTime(routine.lastTriggeredAt)}</span>
          <span>Last enqueued: {fmtTime(routine.lastEnqueuedAt)}</span>
        </div>
      </div>
    </div>
  );
}
