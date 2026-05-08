"use client";

import { useState } from "react";
import { FloatingPanel } from "@/components/ui/floating-panel";
import type {
  EffortLevel,
  TaskPriority,
  TaskStatus,
  TaskType,
} from "@occa/shared/types";
import { DetailField } from "./detail-field";
import {
  EffortSelect,
  PrioritySelect,
  StatusSelect,
  TaskTypeSelect,
} from "./form-controls";
import { TagsEditor } from "./tags-editor";

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
  const [tags, setTags] = useState<string[]>([]);

  const submit = () => {
    if (!title.trim()) return;
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
      width={520}
      triggerRect={triggerRect}
    >
      <div className="px-5 py-4 space-y-3">
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
          className="w-full glass-light rounded-xl px-3 py-2 text-sm text-white/90 outline-none placeholder:text-white/30 focus:ring-1 focus:ring-white/20"
        />

        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
          placeholder="Description — what should the agent do?"
          rows={3}
          className="w-full glass-light rounded-xl px-3 py-2 text-xs text-white/80 outline-none placeholder:text-white/30 focus:ring-1 focus:ring-white/20 resize-y leading-relaxed min-h-20"
        />

        <hr className="border-white/8" />

        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          <DetailField label="Status">
            <StatusSelect value={status} onChange={setStatus} />
          </DetailField>

          <DetailField label="Priority">
            <PrioritySelect value={priority} onChange={setPriority} />
          </DetailField>

          <DetailField label="Type">
            <TaskTypeSelect value={taskType} onChange={setTaskType} />
          </DetailField>

          <DetailField label="Effort">
            <EffortSelect value={effortLevel} onChange={setEffortLevel} />
          </DetailField>

          {agentList && agentList.length > 0 && (
            <DetailField label="Assignee">
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className="w-full appearance-none glass-light rounded-lg px-2 py-1 text-xs text-white/80 cursor-pointer focus:outline-none focus:ring-1 focus:ring-white/20"
              >
                <option value="">Unassigned</option>
                {agentList.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </DetailField>
          )}

          <DetailField label="Due">
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full glass-light rounded-lg px-2 py-1 text-xs text-white/70 cursor-pointer focus:outline-none focus:ring-1 focus:ring-white/20"
            />
          </DetailField>

          <div className="col-span-2">
            <DetailField label="Tags" align="start">
              <TagsEditor tags={tags} onChange={setTags} />
            </DetailField>
          </div>
        </div>

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
