"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  AlertTriangle,
  Check,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { FloatingPanel } from "@/components/ui/floating-panel";
import type {
  ContentBlock,
  TaskDTO,
  UpdateTaskRequest,
} from "@occa/shared/types";
import { taskKeys } from "../api/keys";
import { useArchiveTask } from "../api/use-archive-task";
import { useRerunTask } from "../api/use-rerun-task";
import { useTaskEvents } from "../api/use-task-events";
import { useUnarchiveTask } from "../api/use-unarchive-task";
import { STATUS_COLUMNS } from "../types";
import { formatCreatedFull, isSystemTask } from "../utils";
import { ArchiveConfirmModal } from "./archive-confirm-modal";
import {
  EffortSelect,
  PrioritySelect,
  StatusSelect,
  TaskTypeSelect,
} from "./form-controls";
import { BlockEditor } from "./block-editor";
import { DeliverableJourney } from "./deliverable-journey";
import { RunCost } from "./run-cost";
import { DetailField } from "./detail-field";
import { ReadOnlyBlocks } from "./readonly-blocks";
import { LiveTraceFeed } from "./live-trace-feed";
import { TagsEditor } from "./tags-editor";
import { TaskComments } from "./task-comments";
import { TaskTimeline } from "./task-timeline";

export function TaskDetail({
  task,
  parentTask,
  childTasks,
  triggerRect,
  agentList,
  onUpdate,
  onDelete,
  onClose,
  onNavigateToTask,
}: {
  task: TaskDTO;
  parentTask?: TaskDTO | null;
  childTasks?: TaskDTO[];
  triggerRect?: DOMRect | null;
  agentList?: { id: string; name: string; role: string }[];
  onUpdate: (data: UpdateTaskRequest) => void;
  onDelete: () => void;
  onClose: () => void;
  onNavigateToTask?: (task: TaskDTO) => void;
}) {
  const queryClient = useQueryClient();
  const rerunTask = useRerunTask();
  const archiveTask = useArchiveTask();
  const unarchiveTask = useUnarchiveTask();
  const taskEvents = useTaskEvents(task.id);
  const systemTask = isSystemTask(task);
  const isArchived = task.archivedAt !== null;
  const isLocked = task.status === "in_progress" && !!task.linkedTraceId;
  // Read-only when archived OR when agent is currently running. Both
  // gate the same set of edit interactions in the body.
  const isReadOnly = isLocked || isArchived;
  const canRerun =
    !isLocked &&
    !isArchived &&
    !!task.assignedAgentId &&
    (task.status === "done" || task.status === "review");
  // Auto-suggest archive banner: shown once status hits `review` on a
  // non-system, non-archived task. User can dismiss for the current
  // session; the suggestion comes back on the next open.
  const [reviewBannerDismissed, setReviewBannerDismissed] = useState(false);
  const showReviewBanner =
    !systemTask && !isArchived && task.status === "review" && !reviewBannerDismissed;
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [resultUri, setResultUri] = useState(task.resultUri ?? "");
  const [blocks, setBlocks] = useState<ContentBlock[]>(
    task.blocks?.length ? task.blocks : [{ type: "paragraph", text: "" }],
  );
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Most recent agent_result block — used to source the agent's message
  // for the review banner without re-fetching trace events.
  const lastAgentResult = [...blocks]
    .reverse()
    .find((b): b is Extract<ContentBlock, { type: "agent_result" }> =>
      b.type === "agent_result",
    );

  const handleRerun = useCallback(() => {
    rerunTask.mutate(task.id);
  }, [rerunTask, task.id]);

  // Mark a reviewing task as done — explicit approve from the banner.
  // Triggers the workflow engine via `task_status_changed → done`.
  const handleApprove = useCallback(() => {
    onUpdate({ status: "done" });
  }, [onUpdate]);

  const handleTraceFinish = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
  }, [queryClient]);

  const handleArchiveConfirm = useCallback(
    (reason: string | undefined) => {
      archiveTask.mutate(
        { id: task.id, reason },
        {
          onSuccess: () => {
            setArchiveModalOpen(false);
            // Close the panel — archived tasks vanish from the default
            // board, so leaving the panel open over an empty card is a
            // dead end.
            onClose();
          },
        },
      );
    },
    [archiveTask, task.id, onClose],
  );

  const handleUnarchive = useCallback(() => {
    unarchiveTask.mutate(task.id);
  }, [unarchiveTask, task.id]);

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
    setResultUri(task.resultUri ?? "");
    setBlocks(
      task.blocks?.length ? task.blocks : [{ type: "paragraph", text: "" }],
    );
  }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const headerRight = (
    <div className="flex items-center gap-1.5">
      {saving && <span className="text-[10px] text-white/30 px-1">Saving…</span>}
      {isArchived ? (
        <button
          type="button"
          onClick={handleUnarchive}
          disabled={unarchiveTask.isPending}
          className="p-1 rounded-md hover:bg-emerald-500/10 text-white/30 hover:text-emerald-300 disabled:opacity-40 transition-colors"
          title="Unarchive task"
        >
          <ArchiveRestore className="size-3.5" />
        </button>
      ) : (
        <>
          {canRerun && (
            <button
              type="button"
              onClick={handleRerun}
              disabled={rerunTask.isPending}
              className="p-1 rounded-md hover:bg-blue-500/10 text-white/30 hover:text-blue-300 disabled:opacity-40 transition-colors"
              title="Re-run task"
            >
              <RotateCcw
                className={`size-3.5 ${rerunTask.isPending ? "animate-spin" : ""}`}
              />
            </button>
          )}
          {!systemTask && (
            <button
              type="button"
              onClick={() => setArchiveModalOpen(true)}
              className="p-1 rounded-md hover:bg-amber-500/10 text-white/30 hover:text-amber-300 transition-colors"
              title="Archive task"
            >
              <Archive className="size-3.5" />
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
        </>
      )}
    </div>
  );

  return (
    <FloatingPanel
      title={`Task #${task.taskNumber}`}
      onClose={onClose}
      width={560}
      height={Math.round(window.innerHeight * 0.9)}
      triggerRect={triggerRect}
      zIndex={180}
      headerRight={headerRight}
    >
      {isLocked && task.linkedTraceId && (
        <LiveTraceFeed
          traceId={task.linkedTraceId}
          onFinish={handleTraceFinish}
        />
      )}

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {isArchived && (
          <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 space-y-2">
            <div className="flex items-center gap-2 text-xs text-white/60">
              <Archive className="size-3.5" />
              <span>
                Archived
                {task.archivedAt
                  ? ` on ${new Date(task.archivedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}`
                  : ""}
              </span>
            </div>
            {task.archiveReason && (
              <p className="text-xs text-white/50 italic">
                &ldquo;{task.archiveReason}&rdquo;
              </p>
            )}
            <button
              type="button"
              onClick={handleUnarchive}
              disabled={unarchiveTask.isPending}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-300 disabled:opacity-40 transition-colors"
            >
              <ArchiveRestore className="size-3" />
              {unarchiveTask.isPending ? "Unarchiving…" : "Unarchive task"}
            </button>
          </div>
        )}

        {showReviewBanner && (
          <div className="relative rounded-xl border border-amber-400/20 bg-amber-500/5 px-4 py-3 space-y-2.5">
            <button
              type="button"
              onClick={() => setReviewBannerDismissed(true)}
              className="absolute top-2 right-2 p-1 rounded-md text-white/30 hover:text-white/70 hover:bg-white/8 transition-colors"
              title="Dismiss"
            >
              <X className="size-3" />
            </button>
            <div className="flex items-center gap-2 text-xs text-amber-300/90 pr-6">
              <AlertTriangle className="size-3.5" />
              <span>
                {lastAgentResult?.agentName
                  ? `${lastAgentResult.agentName} returned this for review.`
                  : "Task is in review."}
                <span className="text-white/55"> Decide what&apos;s next:</span>
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleApprove}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 transition-colors"
              >
                <Check className="size-3" />
                Approve — mark done
              </button>
              <button
                type="button"
                onClick={handleRerun}
                disabled={rerunTask.isPending}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-blue-500/15 hover:bg-blue-500/25 text-blue-200 disabled:opacity-40 transition-colors"
              >
                <RotateCcw
                  className={`size-3 ${rerunTask.isPending ? "animate-spin" : ""}`}
                />
                {rerunTask.isPending ? "Re-running…" : "Re-run agent"}
              </button>
              <button
                type="button"
                onClick={() => setArchiveModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 transition-colors"
              >
                <Archive className="size-3" />
                Archive as unresolved
              </button>
            </div>
          </div>
        )}

        {systemTask ? (
          <div className="text-lg font-semibold tracking-tight text-white leading-snug">
            {title}
          </div>
        ) : (
          <textarea
            value={title}
            readOnly={isReadOnly}
            rows={1}
            onChange={(e) => {
              if (isReadOnly) return;
              setTitle(e.target.value);
              scheduleAutoSave({ title: e.target.value, blocks });
            }}
            className={`w-full bg-transparent text-lg font-semibold tracking-tight text-white outline-none placeholder:text-white/20 resize-none leading-snug field-sizing-content ${isReadOnly ? "opacity-60 cursor-not-allowed" : ""}`}
            placeholder="Task title"
          />
        )}

        <hr className="border-white/8" />

        <div
          className={`grid grid-cols-2 gap-x-4 gap-y-2.5 ${isReadOnly ? "pointer-events-none opacity-50" : ""}`}
        >
          <DetailField label="Status">
            {systemTask ? (
              <ReadOnlyValue>
                {STATUS_COLUMNS.find((c) => c.id === task.status)?.label ??
                  task.status}
              </ReadOnlyValue>
            ) : (
              <StatusSelect
                value={task.status}
                onChange={(v) => onUpdate({ status: v })}
              />
            )}
          </DetailField>

          {!systemTask && (
            <DetailField label="Priority">
              <PrioritySelect
                value={task.priority}
                onChange={(v) => onUpdate({ priority: v })}
              />
            </DetailField>
          )}

          {!systemTask && (
            <DetailField label="Type">
              <TaskTypeSelect
                value={task.taskType}
                onChange={(v) => onUpdate({ taskType: v })}
              />
            </DetailField>
          )}

          {!systemTask && (
            <DetailField label="Effort">
              <EffortSelect
                value={task.effortLevel}
                onChange={(v) => onUpdate({ effortLevel: v })}
              />
            </DetailField>
          )}

          {!systemTask && (
            <DetailField label="Assignee">
              <ReadOnlyValue>
                {task.assignedAgentId
                  ? (agentList?.find((a) => a.id === task.assignedAgentId)?.name ??
                    "Unknown agent")
                  : "Unassigned"}
              </ReadOnlyValue>
            </DetailField>
          )}

          {!systemTask && (
            <DetailField label="Due">
              <input
                type="date"
                value={task.dueDate ? task.dueDate.slice(0, 10) : ""}
                onChange={(e) => onUpdate({ dueDate: e.target.value || null })}
                className="w-full glass-light rounded-lg px-2 py-1 text-xs text-white/70 cursor-pointer focus:outline-none focus:ring-1 focus:ring-white/20"
              />
            </DetailField>
          )}

          <DetailField label="Created">
            <ReadOnlyValue>{formatCreatedFull(task.createdAt)}</ReadOnlyValue>
          </DetailField>

          <DetailField label="Updated">
            <ReadOnlyValue>{formatCreatedFull(task.updatedAt)}</ReadOnlyValue>
          </DetailField>

          {parentTask && (
            <div className="col-span-2">
              <DetailField label="Parent">
                <button
                  type="button"
                  onClick={() => onNavigateToTask?.(parentTask)}
                  className="w-full glass-light rounded-lg px-2 py-1 text-xs text-white/70 hover:text-white/95 hover:bg-white/8 transition-colors text-left flex items-center gap-2"
                >
                  <span className="font-mono text-white/40 shrink-0">
                    #{parentTask.taskNumber}
                  </span>
                  <span className="truncate">{parentTask.title}</span>
                </button>
              </DetailField>
            </div>
          )}

          {!systemTask && (
            <div className="col-span-2">
              <DetailField label="Result URL" align="start">
                <input
                  type="url"
                  value={resultUri}
                  placeholder="https://… (published deliverable)"
                  onChange={(e) => setResultUri(e.target.value)}
                  onBlur={() => {
                    const next = resultUri.trim();
                    if (next === (task.resultUri ?? "")) return;
                    onUpdate({ resultUri: next || null });
                  }}
                  className="w-full glass-light rounded-lg px-2 py-1 text-xs text-white/70 placeholder:text-white/25 focus:outline-none focus:ring-1 focus:ring-white/20"
                />
              </DetailField>
            </div>
          )}

          <div className="col-span-2">
            <DetailField label="Tags" align="start">
              {systemTask ? (
                <div className="flex flex-wrap gap-1.5 py-1">
                  {task.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full glass-light px-2 py-0.5 text-[10px] text-white/50"
                    >
                      {tag}
                    </span>
                  ))}
                  {task.tags.length === 0 && (
                    <span className="text-xs text-white/30 py-1">—</span>
                  )}
                </div>
              ) : (
                <TagsEditor
                  tags={task.tags}
                  onChange={(tags) => onUpdate({ tags })}
                />
              )}
            </DetailField>
          </div>
        </div>

        {childTasks && childTasks.length > 0 && (
          <>
            <hr className="border-white/8" />
            <div className="space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-white/45">
                Subtasks ({childTasks.length})
              </div>
              <div className="space-y-1">
                {childTasks.map((child) => {
                  const statusCol = STATUS_COLUMNS.find(
                    (c) => c.id === child.status,
                  );
                  return (
                    <button
                      key={child.id}
                      type="button"
                      onClick={() => onNavigateToTask?.(child)}
                      className="w-full glass-light rounded-lg px-2.5 py-1.5 text-xs text-white/75 hover:text-white/95 hover:bg-white/8 transition-colors text-left flex items-center gap-2"
                    >
                      <span className="font-mono text-white/40 shrink-0">
                        #{child.taskNumber}
                      </span>
                      <span className="flex items-center gap-1 shrink-0">
                        <span
                          className={`size-1.5 rounded-full ${statusCol?.dot ?? "bg-white/30"}`}
                        />
                        <span className="text-[10px] text-white/45 capitalize">
                          {statusCol?.label ?? child.status}
                        </span>
                      </span>
                      <span className="truncate">{child.title}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}

        <hr className="border-white/8" />

        {systemTask || isReadOnly ? (
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

        <RunCost taskId={task.id} />

        <DeliverableJourney task={task} events={taskEvents.data ?? []} />

        <hr className="border-white/8" />

        <TaskComments taskId={task.id} agentList={agentList} />

        <hr className="border-white/8" />

        <details className="group" open>
          <summary className="cursor-pointer list-none flex items-center gap-2 text-xs text-white/50 hover:text-white/70 transition-colors select-none">
            <span className="text-white/30 group-open:rotate-90 transition-transform inline-block">
              ▶
            </span>
            Activity
            {taskEvents.data && taskEvents.data.length > 0 && (
              <span className="text-[10px] text-white/30">
                ({taskEvents.data.length})
              </span>
            )}
          </summary>
          <div className="mt-3">
            {taskEvents.isPending && taskEvents.isFetching ? (
              <div className="text-xs text-white/30">Loading…</div>
            ) : taskEvents.isError ? (
              <div className="text-xs text-red-400/70">
                Failed to load activity.
              </div>
            ) : (
              <TaskTimeline
                events={taskEvents.data ?? []}
                agentList={agentList}
              />
            )}
          </div>
        </details>
      </div>

      <ArchiveConfirmModal
        open={archiveModalOpen}
        pending={archiveTask.isPending}
        taskNumber={task.taskNumber}
        onCancel={() => setArchiveModalOpen(false)}
        onConfirm={handleArchiveConfirm}
      />
    </FloatingPanel>
  );
}

function ReadOnlyValue({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block glass-light rounded-lg px-2 py-1 text-xs text-white/60 capitalize">
      {children}
    </span>
  );
}

