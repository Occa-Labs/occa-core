"use client";

import { useState } from "react";
import { FloatingPanel } from "@/components/ui/floating-panel";
import type {
  EffortLevel,
  TaskPriority,
  TaskStatus,
  TaskType,
} from "@occa/shared/types";
import {
  EffortSelect,
  PrioritySelect,
  StatusSelect,
  TaskTypeSelect,
} from "./_form-controls";

export interface NewTaskFormData {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  taskType: TaskType;
  effortLevel: EffortLevel;
  assignedAgentId?: string;
  dueDate?: string;
  tags: string[];
}

export function NewTaskModal({
  defaultStatus,
  triggerRect,
  agentList,
  onConfirm,
  onCancel,
}: {
  defaultStatus: TaskStatus;
  triggerRect?: DOMRect | null;
  agentList?: { id: string; name: string; role: string }[];
  onConfirm: (data: NewTaskFormData) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<TaskStatus>(defaultStatus);
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [taskType, setTaskType] = useState<TaskType>("other");
  const [effortLevel, setEffortLevel] = useState<EffortLevel>("m");
  const [agentId, setAgentId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [tagsInput, setTagsInput] = useState("");

  const submit = () => {
    if (!title.trim()) return;
    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    onConfirm({
      title: title.trim(),
      description: description.trim(),
      status,
      priority,
      taskType,
      effortLevel,
      assignedAgentId: agentId || undefined,
      dueDate: dueDate || undefined,
      tags,
    });
  };

  return (
    <FloatingPanel
      title="New Task"
      onClose={onCancel}
      width={420}
      triggerRect={triggerRect}
    >
      <div className="p-4 space-y-3">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") onCancel();
          }}
          placeholder="Task title…"
          className="w-full bg-white/5 rounded-xl px-3 py-2 text-sm text-white/90 outline-none placeholder:text-white/30 focus:ring-1 focus:ring-white/20 border border-white/8"
        />

        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
          placeholder="Description (what should the agent do?)"
          rows={3}
          className="w-full bg-white/5 rounded-xl px-3 py-2 text-xs text-white/80 outline-none placeholder:text-white/30 focus:ring-1 focus:ring-white/20 resize-none border border-white/8"
        />

        <div className="flex gap-2 flex-wrap">
          <StatusSelect value={status} onChange={setStatus} />
          <PrioritySelect value={priority} onChange={setPriority} />
          <TaskTypeSelect value={taskType} onChange={setTaskType} />
          <EffortSelect value={effortLevel} onChange={setEffortLevel} />
        </div>

        <div className="flex gap-2">
          {agentList && agentList.length > 0 && (
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="flex-1 appearance-none bg-white/5 border border-white/8 rounded-xl px-3 py-2 text-xs text-white/70 cursor-pointer focus:outline-none focus:ring-1 focus:ring-white/20"
            >
              <option value="">Unassigned</option>
              {agentList.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.role.toUpperCase()})
                </option>
              ))}
            </select>
          )}
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="flex-1 bg-white/5 border border-white/8 rounded-xl px-3 py-2 text-xs text-white/70 outline-none focus:ring-1 focus:ring-white/20"
          />
        </div>

        <input
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
          placeholder="Tags (comma-separated)"
          className="w-full bg-white/5 border border-white/8 rounded-xl px-3 py-2 text-xs text-white/80 outline-none placeholder:text-white/30 focus:ring-1 focus:ring-white/20"
        />

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-xs text-white/40 hover:bg-white/8 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!title.trim()}
            onClick={submit}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/15 text-white/80 disabled:opacity-40 transition-colors"
          >
            Create
          </button>
        </div>
      </div>
    </FloatingPanel>
  );
}
