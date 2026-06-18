"use client";

// Routine form — create or edit. The schedule picker offers three shapes:
// an interval (every N minutes or hours), a daily time, or a raw cron,
// each compiled to a cron expression. Passing `initial` switches the form
// to edit mode: fields are prefilled and the button reads "Save changes".

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export interface AgentOption {
  id: string;
  name: string;
  role: string;
}

/** Normalized form output — the parent maps this to create/update calls. */
export interface RoutineFormValues {
  title: string;
  description?: string;
  assigneeAgentId: string;
  cronExpression: string;
  timezone: string;
  /** When set, a fire runs this sequential workflow instead of the mandate. */
  workflowYamlId?: string;
}

interface RoutineFormProps {
  agents: AgentOption[];
  /** Company workflows for the optional pipeline picker (yaml id + name). */
  workflows: { yamlId: string; name: string }[];
  /** Present → edit mode (fields prefilled, "Save changes" button). */
  initial?: RoutineFormValues;
  submitting: boolean;
  error: string | null;
  onSubmit: (values: RoutineFormValues) => void;
  onCancel: () => void;
}

const BROWSER_TZ =
  typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "UTC";

type Frequency = "interval" | "daily" | "custom";
type IntervalUnit = "minutes" | "hours";

const MAX_MINUTES = 59;
const MAX_HOURS = 23;

/** Interval (value + unit) → cron expression. */
function intervalCron(value: number, unit: IntervalUnit): string {
  if (unit === "minutes") {
    const n = Math.min(MAX_MINUTES, Math.max(1, value));
    return `*/${n} * * * *`;
  }
  const n = Math.min(MAX_HOURS, Math.max(1, value));
  return n === 1 ? "0 * * * *" : `0 */${n} * * *`;
}

/** "HH:MM" → cron "M H * * *". */
function dailyCron(time: string): string {
  const [h, m] = time.split(":");
  return `${Number(m)} ${Number(h)} * * *`;
}

interface ScheduleState {
  frequency: Frequency;
  unit: IntervalUnit;
  intervalValue: number;
  time: string;
  custom: string;
}

/**
 * Reverse a cron back to the schedule UI it came from — used to prefill
 * the form in edit mode. Anything outside the shapes the form generates
 * falls back to the custom-cron field.
 */
function parseCron(cron: string): ScheduleState {
  const base: ScheduleState = {
    frequency: "custom",
    unit: "hours",
    intervalValue: 1,
    time: "09:00",
    custom: cron,
  };
  const everyMin = cron.match(/^\*\/(\d+) \* \* \* \*$/);
  if (everyMin) {
    return { ...base, frequency: "interval", unit: "minutes", intervalValue: Number(everyMin[1]) };
  }
  const everyHour = cron.match(/^0 \*\/(\d+) \* \* \*$/);
  if (everyHour) {
    return { ...base, frequency: "interval", unit: "hours", intervalValue: Number(everyHour[1]) };
  }
  if (cron === "0 * * * *") {
    return { ...base, frequency: "interval", unit: "hours", intervalValue: 1 };
  }
  const daily = cron.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (daily) {
    const hh = daily[2].padStart(2, "0");
    const mm = daily[1].padStart(2, "0");
    return { ...base, frequency: "daily", time: `${hh}:${mm}` };
  }
  return base;
}

export function RoutineForm({
  agents,
  workflows,
  initial,
  submitting,
  error,
  onSubmit,
  onCancel,
}: RoutineFormProps) {
  const isEdit = initial !== undefined;
  const sched = parseCron(initial?.cronExpression ?? "0 * * * *");

  const [title, setTitle] = useState(initial?.title ?? "");
  const [mandate, setMandate] = useState(initial?.description ?? "");
  const [assigneeId, setAssigneeId] = useState(
    initial?.assigneeAgentId ?? agents[0]?.id ?? "",
  );
  const [workflowYamlId, setWorkflowYamlId] = useState(
    initial?.workflowYamlId ?? "",
  );
  const [frequency, setFrequency] = useState<Frequency>(sched.frequency);
  const [unit, setUnit] = useState<IntervalUnit>(sched.unit);
  const [intervalValue, setIntervalValue] = useState(sched.intervalValue);
  const [time, setTime] = useState(sched.time);
  const [customCron, setCustomCron] = useState(sched.custom);

  const cronExpression =
    frequency === "daily"
      ? dailyCron(time)
      : frequency === "interval"
        ? intervalCron(intervalValue, unit)
        : customCron.trim();

  const canSubmit =
    title.trim().length > 0 &&
    assigneeId !== "" &&
    cronExpression.length > 0 &&
    !submitting;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      title: title.trim(),
      description: mandate.trim() || undefined,
      assigneeAgentId: assigneeId,
      cronExpression,
      timezone: initial?.timezone ?? BROWSER_TZ,
      workflowYamlId: workflowYamlId.trim() || undefined,
    });
  };

  // Switching unit resets the value to a sane default for that unit so a
  // "30 minutes" pick does not survive as an invalid "30 hours".
  const changeUnit = (next: IntervalUnit) => {
    setUnit(next);
    setIntervalValue(next === "minutes" ? 30 : 1);
  };

  return (
    <div className="flex flex-col gap-5 p-6">
      <p className="text-[12px] text-white/40">
        A scheduled wake-up. The assigned agent runs the mandate below on the
        cron you set.
      </p>

      <Input
        label="Title"
        placeholder="News cycle"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />

      <Textarea
        label="Mandate"
        placeholder="What the agent should do each time this routine wakes it…"
        rows={7}
        value={mandate}
        onChange={(e) => setMandate(e.target.value)}
        hint="Travels inline in the agent's wake prompt — be explicit."
      />

      <Select
        label="Assign to"
        value={assigneeId}
        onChange={(e) => setAssigneeId(e.target.value)}
      >
        {agents.length === 0 && <option value="">No agents available</option>}
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · {a.role}
          </option>
        ))}
      </Select>

      <Select
        label="Workflow (optional)"
        value={workflowYamlId}
        onChange={(e) => setWorkflowYamlId(e.target.value)}
        hint="Bind a sequential pipeline. On each fire it runs that workflow instead of the mandate, and the assignee becomes the pipeline owner. Leave as None for a normal routine."
      >
        <option value="">None — run the mandate above</option>
        {workflows.map((w) => (
          <option key={w.yamlId} value={w.yamlId}>
            {w.name} ({w.yamlId})
          </option>
        ))}
      </Select>

      <Select
        label="Schedule"
        value={frequency}
        onChange={(e) => setFrequency(e.target.value as Frequency)}
      >
        <option value="interval">Repeat every…</option>
        <option value="daily">Daily at a time</option>
        <option value="custom">Custom cron</option>
      </Select>

      {frequency === "interval" && (
        <div>
          <div className="flex items-end gap-3">
            <Input
              label="Run every"
              type="number"
              min={1}
              max={unit === "minutes" ? MAX_MINUTES : MAX_HOURS}
              value={intervalValue}
              onChange={(e) => setIntervalValue(Number(e.target.value) || 1)}
              className="w-28"
            />
            <Select
              value={unit}
              onChange={(e) => changeUnit(e.target.value as IntervalUnit)}
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </Select>
          </div>
          <p className="mt-2 text-[11px] text-white/35">
            Cron:{" "}
            <code className="font-mono text-white/55">{cronExpression}</code>
          </p>
        </div>
      )}

      {frequency === "daily" && (
        <Input
          label="Run daily at"
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          hint={`Timezone: ${initial?.timezone ?? BROWSER_TZ}`}
        />
      )}

      {frequency === "custom" && (
        <Input
          label="Cron expression"
          placeholder="*/30 * * * *"
          value={customCron}
          onChange={(e) => setCustomCron(e.target.value)}
          hint="Standard 5-field cron. Invalid expressions are rejected on save."
        />
      )}

      {error && <p className="text-[12px] text-red-300/80">{error}</p>}

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={!canSubmit}
          onClick={submit}
        >
          {submitting
            ? "Saving…"
            : isEdit
              ? "Save changes"
              : "Create routine"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
