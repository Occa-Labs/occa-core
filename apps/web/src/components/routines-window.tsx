"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Clock, Loader2, Plus, Trash2 } from "lucide-react";
import { AppWindow } from "@/components/ui/app-window";
import { useRoutines } from "@/hooks/use-routines";
import type { AgentDTO, RoutineDTO } from "@occa/shared/types";

interface RoutinesWindowProps {
  agents: AgentDTO[];
  onClose?: () => void;
}

export function RoutinesWindow({ agents, onClose }: RoutinesWindowProps) {
  const { routines, loading, error, create, update, remove } =
    useRoutines(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!selectedId && routines.length > 0 && !creating) {
      setSelectedId(routines[0].id);
    }
  }, [routines, selectedId, creating]);

  const selected = useMemo(
    () => routines.find((r) => r.id === selectedId) ?? null,
    [routines, selectedId],
  );

  return (
    <AppWindow
      title="Routines"
      subtitle={`${routines.length} routine${routines.length !== 1 ? "s" : ""}`}
      onClose={onClose}
      defaultSize={{
        w: Math.min(1000, Math.round(window.innerWidth * 0.82)),
        h: Math.min(680, Math.round(window.innerHeight * 0.82)),
      }}
      minWidth={720}
      minHeight={440}
    >
      <div className="flex h-full overflow-hidden">
        <RoutineSidebar
          routines={routines}
          selectedId={creating ? null : selectedId}
          onSelect={(id) => {
            setCreating(false);
            setSelectedId(id);
          }}
          onCreate={() => {
            setCreating(true);
            setSelectedId(null);
          }}
          loading={loading}
        />
        <div className="flex-1 min-w-0 overflow-y-auto">
          {error && (
            <div className="px-5 pt-4">
              <div className="flex items-center gap-2 text-xs text-red-300/80">
                <AlertCircle className="size-3.5" /> {error}
              </div>
            </div>
          )}
          {creating ? (
            <RoutineCreateForm
              agents={agents}
              onCancel={() => setCreating(false)}
              onCreate={async (input) => {
                const row = await create(input);
                if (row) {
                  setCreating(false);
                  setSelectedId(row.id);
                }
              }}
            />
          ) : selected ? (
            <RoutineDetail
              routine={selected}
              agents={agents}
              onUpdate={(input) => update(selected.id, input)}
              onRemove={async () => {
                const ok = await remove(selected.id);
                if (ok) setSelectedId(null);
              }}
            />
          ) : routines.length === 0 && !loading ? (
            <div className="p-8 text-center space-y-2">
              <p className="text-sm text-white/50">No routines yet</p>
              <p className="text-xs text-white/35">
                Create a routine to schedule recurring agent work.
              </p>
            </div>
          ) : (
            <div className="p-8 flex items-center justify-center text-xs text-white/40">
              {loading && <Loader2 className="size-3.5 animate-spin mr-2" />}
              Select a routine
            </div>
          )}
        </div>
      </div>
    </AppWindow>
  );
}

function RoutineSidebar({
  routines,
  selectedId,
  onSelect,
  onCreate,
  loading,
}: {
  routines: RoutineDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  loading: boolean;
}) {
  return (
    <div className="w-60 shrink-0 flex flex-col border-r border-white/8">
      <div className="px-3 py-3 border-b border-white/8 flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-white/40">
          Routines
        </div>
        <button
          onClick={onCreate}
          className="flex items-center gap-1 text-[11px] text-white/70 hover:text-white bg-white/8 hover:bg-white/15 rounded px-2 py-1"
        >
          <Plus className="size-3" /> New
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && routines.length === 0 && (
          <div className="p-4 flex items-center gap-2 text-xs text-white/40">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        )}
        {routines.map((r) => {
          const active = r.id === selectedId;
          const cronTrigger = r.triggers.find((t) => t.kind === "cron");
          return (
            <button
              key={r.id}
              onClick={() => onSelect(r.id)}
              className={`relative w-full text-left flex flex-col gap-0.5 px-3 py-2 border-b border-white/6 transition-colors ${
                active ? "bg-white/8" : "hover:bg-white/4"
              }`}
            >
              {active && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-white/80" />
              )}
              <div className="text-xs font-medium text-white/90 truncate">
                {r.title}
              </div>
              <div className="text-[10px] text-white/40 font-mono truncate flex items-center gap-1">
                <Clock className="size-2.5" />
                {cronTrigger?.cronExpression ?? "no trigger"}
              </div>
              {r.status !== "active" && (
                <span className="text-[10px] uppercase text-amber-200/80">
                  {r.status}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function RoutineDetail({
  routine,
  agents,
  onUpdate,
  onRemove,
}: {
  routine: RoutineDTO;
  agents: AgentDTO[];
  onUpdate: (input: {
    title?: string;
    description?: string;
    assigneeAgentId?: string;
    status?: string;
  }) => Promise<RoutineDTO | null>;
  onRemove: () => Promise<void>;
}) {
  const [title, setTitle] = useState(routine.title);
  const [description, setDescription] = useState(routine.description ?? "");
  const [assigneeAgentId, setAssignee] = useState(routine.assigneeAgentId ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTitle(routine.title);
    setDescription(routine.description ?? "");
    setAssignee(routine.assigneeAgentId ?? "");
  }, [routine.id, routine.title, routine.description, routine.assigneeAgentId]);

  const dirty =
    title !== routine.title ||
    description !== (routine.description ?? "") ||
    assigneeAgentId !== (routine.assigneeAgentId ?? "");

  const assigneeName =
    agents.find((a) => a.id === routine.assigneeAgentId)?.name ?? "—";

  const cronTrigger = routine.triggers.find((t) => t.kind === "cron");
  const paused = routine.status !== "active";

  const handleSave = async () => {
    setSaving(true);
    await onUpdate({
      title,
      description,
      assigneeAgentId: assigneeAgentId || undefined,
    });
    setSaving(false);
  };

  const handleToggleStatus = () => {
    void onUpdate({ status: paused ? "active" : "paused" });
  };

  return (
    <div className="p-5 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0 space-y-1">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full bg-transparent text-base font-semibold text-white/90 outline-none border-b border-transparent focus:border-white/20"
          />
          <div className="text-[11px] text-white/40">Created {formatWhen(routine.createdAt)}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleToggleStatus}
            className={`text-xs rounded px-2 py-1 ${
              paused
                ? "bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200"
                : "bg-white/8 hover:bg-white/15 text-white/70"
            }`}
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            onClick={onRemove}
            className="flex items-center gap-1 text-xs rounded px-2 py-1 bg-red-500/15 hover:bg-red-500/25 text-red-200"
          >
            <Trash2 className="size-3" /> Delete
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Assignee">
          <select
            value={assigneeAgentId}
            onChange={(e) => setAssignee(e.target.value)}
            className="w-full bg-white/5 rounded px-2 py-1.5 text-xs text-white/80"
          >
            <option value="">—</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.role})
              </option>
            ))}
          </select>
          <div className="text-[10px] text-white/40 mt-0.5">Current: {assigneeName}</div>
        </Field>
        <Field label="Schedule">
          <div className="text-xs text-white/70 font-mono">
            {cronTrigger?.cronExpression ?? "—"}
          </div>
          <div className="text-[10px] text-white/40">
            {cronTrigger?.timezone ?? "UTC"}
          </div>
        </Field>
        <Field label="Last triggered">
          <div className="text-xs text-white/70">
            {formatWhen(routine.lastTriggeredAt)}
          </div>
        </Field>
        <Field label="Next run">
          <div className="text-xs text-white/70">
            {formatWhen(cronTrigger?.nextRunAt ?? null)}
          </div>
        </Field>
      </div>

      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          className="w-full bg-white/5 rounded px-2 py-1.5 text-xs text-white/80"
        />
      </Field>

      {dirty && (
        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-emerald-500/90 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
    </div>
  );
}

function RoutineCreateForm({
  agents,
  onCancel,
  onCreate,
}: {
  agents: AgentDTO[];
  onCancel: () => void;
  onCreate: (input: {
    title: string;
    description?: string;
    assigneeAgentId: string;
    triggers: Array<{
      kind: "cron";
      cronExpression: string;
      timezone?: string;
    }>;
  }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeAgentId, setAssignee] = useState(agents[0]?.id ?? "");
  const [cronExpression, setCron] = useState("*/5 * * * *");
  const [timezone, setTimezone] = useState("UTC");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = title.trim() && assigneeAgentId && cronExpression.trim();

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        title: title.trim(),
        description: description.trim() || undefined,
        assigneeAgentId,
        triggers: [
          {
            kind: "cron",
            cronExpression: cronExpression.trim(),
            timezone,
          },
        ],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-5 space-y-4">
      <h3 className="text-sm font-semibold text-white/90">New routine</h3>
      <Field label="Title">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full bg-white/5 rounded px-2 py-1.5 text-xs text-white/80"
          placeholder="e.g. Daily standup digest"
        />
      </Field>
      <Field label="Assignee">
        <select
          value={assigneeAgentId}
          onChange={(e) => setAssignee(e.target.value)}
          className="w-full bg-white/5 rounded px-2 py-1.5 text-xs text-white/80"
        >
          <option value="">Select agent…</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.role})
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Cron expression">
          <input
            value={cronExpression}
            onChange={(e) => setCron(e.target.value)}
            className="w-full bg-white/5 rounded px-2 py-1.5 text-xs font-mono text-white/80"
            placeholder="*/5 * * * *"
          />
          <div className="text-[10px] text-white/40 mt-0.5">
            min hour day mon dow
          </div>
        </Field>
        <Field label="Timezone">
          <input
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="w-full bg-white/5 rounded px-2 py-1.5 text-xs text-white/80"
            placeholder="UTC"
          />
        </Field>
      </div>
      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="w-full bg-white/5 rounded px-2 py-1.5 text-xs text-white/80"
        />
      </Field>
      {error && (
        <div className="flex items-center gap-2 text-xs text-red-300/80">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="text-xs text-white/60 hover:text-white/90 px-3 py-1.5"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit || submitting}
          className="bg-emerald-500/90 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded"
        >
          {submitting ? "Creating…" : "Create"}
        </button>
      </div>
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
      <div className="text-[10px] uppercase tracking-wider text-white/40">
        {label}
      </div>
      {children}
    </div>
  );
}
