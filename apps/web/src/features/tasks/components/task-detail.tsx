"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Calendar, Flag, RotateCcw, Tag, Trash2, User, X } from "lucide-react";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { tasksApi } from "@/lib/api";
import type {
  ContentBlock,
  TaskDTO,
  UpdateTaskRequest,
} from "@occa/shared/types";
import { isSystemTask, STATUS_COLUMNS } from "./_shared";
import {
  EffortSelect,
  PriorityBadge,
  PrioritySelect,
  StatusSelect,
  TaskTypeSelect,
} from "./_form-controls";
import { BlockEditor } from "./block-editor";
import { ReadOnlyBlocks } from "./readonly-blocks";
import { LiveTraceFeed } from "./live-trace-feed";

export function TaskDetail({
  task,
  triggerRect,
  agentList,
  onUpdate,
  onDelete,
  onClose,
  onReload,
}: {
  task: TaskDTO;
  triggerRect?: DOMRect | null;
  agentList?: { id: string; name: string; role: string }[];
  onUpdate: (data: UpdateTaskRequest) => void;
  onDelete: () => void;
  onClose: () => void;
  onReload: () => void;
}) {
  const systemTask = isSystemTask(task);
  const isLocked = task.status === "in_progress" && !!task.linkedTraceId;
  const canRerun =
    !isLocked &&
    !!task.assignedAgentId &&
    (task.status === "done" || task.status === "review");
  const [title, setTitle] = useState(task.title);
  const [blocks, setBlocks] = useState<ContentBlock[]>(
    task.blocks?.length ? task.blocks : [{ type: "paragraph", text: "" }],
  );
  const [saving, setSaving] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleRerun = useCallback(async () => {
    setRerunning(true);
    try {
      await tasksApi.rerun(task.id);
    } finally {
      setRerunning(false);
    }
  }, [task.id]);

  const scheduleAutoSave = useCallback(
    (updates: UpdateTaskRequest) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        setSaving(true);
        onUpdate(updates);
        setTimeout(() => setSaving(false), 600);
      }, 800);
    },
    [onUpdate],
  );

  useEffect(() => {
    setTitle(task.title);
    setBlocks(
      task.blocks?.length ? task.blocks : [{ type: "paragraph", text: "" }],
    );
  }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const headerRight = (
    <div className="flex items-center gap-1.5">
      {systemTask ? (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/50 font-mono">
          ⚙ SYSTEM
        </span>
      ) : (
        <PriorityBadge priority={task.priority} />
      )}
      {saving && <span className="text-[10px] text-white/30 px-1">Saving…</span>}
      {canRerun && (
        <button
          type="button"
          onClick={() => void handleRerun()}
          disabled={rerunning}
          className="p-1 rounded-md hover:bg-blue-500/10 text-white/30 hover:text-blue-300 disabled:opacity-40 transition-colors"
          title="Re-run task"
        >
          <RotateCcw className={`size-3.5 ${rerunning ? "animate-spin" : ""}`} />
        </button>
      )}
      {!systemTask && (
        <button
          type="button"
          onClick={onDelete}
          className="p-1 rounded-md hover:bg-red-500/10 text-white/30 hover:text-red-400 transition-colors"
          title="Delete task"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );

  return (
    <FloatingPanel
      title={`Task #${task.taskNumber}`}
      onClose={onClose}
      width={480}
      triggerRect={triggerRect}
      zIndex={180}
      headerRight={headerRight}
    >
      {isLocked && task.linkedTraceId && (
        <LiveTraceFeed traceId={task.linkedTraceId} onFinish={onReload} />
      )}

      <div className="px-5 py-4 space-y-4">
        {systemTask ? (
          <div className="w-full bg-transparent text-lg font-semibold tracking-tight text-white border-b border-white/8 pb-2">
            {title}
          </div>
        ) : (
          <input
            value={title}
            readOnly={isLocked}
            onChange={(e) => {
              if (isLocked) return;
              setTitle(e.target.value);
              scheduleAutoSave({ title: e.target.value, blocks });
            }}
            className={`w-full bg-transparent text-lg font-semibold tracking-tight text-white outline-none placeholder:text-white/20 border-b border-white/8 pb-2 ${isLocked ? "opacity-60 cursor-not-allowed" : ""}`}
            placeholder="Task title"
          />
        )}

        <div
          className={`flex flex-wrap items-center gap-3 text-xs ${isLocked ? "pointer-events-none opacity-50" : ""}`}
        >
          <div className="flex items-center gap-1.5 text-white/40">
            <Flag className="size-3.5" />
            <span>Status</span>
            {systemTask ? (
              <span className="glass-light rounded-lg px-3 py-1.5 text-xs text-white/60 capitalize">
                {STATUS_COLUMNS.find((c) => c.id === task.status)?.label ??
                  task.status}
              </span>
            ) : (
              <StatusSelect
                value={task.status}
                onChange={(v) => onUpdate({ status: v })}
              />
            )}
          </div>
          {!systemTask && (
            <div className="flex items-center gap-1.5 text-white/40">
              <Flag className="size-3.5" />
              <span>Priority</span>
              <PrioritySelect
                value={task.priority}
                onChange={(v) => onUpdate({ priority: v })}
              />
            </div>
          )}
          {!systemTask && (
            <div className="flex items-center gap-1.5 text-white/40">
              <span>Type</span>
              <TaskTypeSelect
                value={task.taskType}
                onChange={(v) => onUpdate({ taskType: v })}
              />
            </div>
          )}
          {!systemTask && (
            <div className="flex items-center gap-1.5 text-white/40">
              <span>Effort</span>
              <EffortSelect
                value={task.effortLevel}
                onChange={(v) => onUpdate({ effortLevel: v })}
              />
            </div>
          )}
          {!systemTask && agentList && agentList.length > 0 && (
            <div className="flex items-center gap-1.5 text-white/40">
              <User className="size-3.5" />
              <span>Assignee</span>
              <select
                value={task.assignedAgentId ?? ""}
                onChange={(e) =>
                  onUpdate({ assignedAgentId: e.target.value || null })
                }
                className="appearance-none glass-light rounded-lg px-2 py-1 text-xs text-white/80 cursor-pointer focus:outline-none focus:ring-1 focus:ring-white/20"
              >
                <option value="">Unassigned</option>
                {agentList.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {!systemTask && (
            <div className="flex items-center gap-1.5 text-white/40">
              <Calendar className="size-3.5" />
              <input
                type="date"
                value={task.dueDate ? task.dueDate.slice(0, 10) : ""}
                onChange={(e) =>
                  onUpdate({ dueDate: e.target.value || null })
                }
                className="bg-transparent glass-light rounded-lg px-2 py-1 text-xs text-white/70 cursor-pointer focus:outline-none focus:ring-1 focus:ring-white/20"
              />
            </div>
          )}
        </div>

        {systemTask ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Tag className="size-3.5 text-white/30" />
            {task.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full glass-light px-2 py-0.5 text-[10px] text-white/50"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : (
          <TagsEditor tags={task.tags} onChange={(tags) => onUpdate({ tags })} />
        )}

        <hr className="border-white/8" />

        {systemTask ? (
          <ReadOnlyBlocks blocks={blocks} />
        ) : (
          <BlockEditor
            blocks={blocks}
            onChange={(b) => {
              setBlocks(b);
              scheduleAutoSave({ title, blocks: b });
            }}
          />
        )}
      </div>
    </FloatingPanel>
  );
}

function TagsEditor({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [input, setInput] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Tag className="size-3.5 text-white/30" />
      {tags.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-1 rounded-full glass-light px-2 py-0.5 text-[10px] text-white/60"
        >
          {tag}
          <button
            onClick={() => onChange(tags.filter((t) => t !== tag))}
            className="hover:text-red-400 transition-colors"
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === ",") && input.trim()) {
            e.preventDefault();
            const tag = input.trim().replace(/,/g, "");
            if (!tags.includes(tag)) onChange([...tags, tag]);
            setInput("");
          }
        }}
        placeholder="Add tag…"
        className="bg-transparent text-[10px] text-white/40 placeholder:text-white/20 outline-none w-16"
      />
    </div>
  );
}
