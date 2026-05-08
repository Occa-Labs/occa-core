// Task CRUD routes — user JWT authenticated. Mounted under /api/tasks.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import type { TaskDTO, TaskStatus } from "@occa/shared/types";
import { childLogger } from "../../../lib/logger";
import { requireAuth } from "../../../middleware/auth";
import { enqueueTaskDispatch } from "../../../infra/queue/task-worker";
import { createTaskRecord } from "../../../infra/database/task-creation";
import {
  agentNameMap,
  deploymentInCompany,
  deleteTaskInCompany,
  findTaskInCompany,
  listTasksByCompany,
  updateTask,
} from "../repositories/tasks";
import { createTaskBody, updateTaskBody } from "../domain/schemas";
import { isUserStatusTransitionAllowed } from "../domain/status-transitions";
import { appendTaskEventBestEffort } from "../services/events";
import { toTaskDTO, userCompanyId } from "./helpers";

const log = childLogger("routes:tasks");

const router: Router = Router();

router.get("/", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  // `include_archived=1` opts the response into archived rows. Default is
  // active-only so the kanban board doesn't have to filter client-side.
  const includeArchived = req.query.include_archived === "1";
  const rows = await listTasksByCompany(companyId, { includeArchived });
  const names = await agentNameMap(companyId);
  const tasksDto: TaskDTO[] = rows.map((r) =>
    toTaskDTO(
      r,
      r.assignedDeploymentId
        ? (names.get(r.assignedDeploymentId) ?? null)
        : null,
    ),
  );
  res.json({ tasks: tasksDto });
});

router.post("/", requireAuth, async (req: Request, res: Response) => {
  const parsed = createTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_BODY,
      detail: parsed.error.flatten(),
    });
    return;
  }
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }

  if (parsed.data.assignedAgentId) {
    const ok = await deploymentInCompany(companyId, parsed.data.assignedAgentId);
    if (!ok) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: "agent_not_in_company" });
      return;
    }
  }

  const row = await createTaskRecord({
    companyId,
    title: parsed.data.title,
    blocks: parsed.data.blocks ?? [],
    status: parsed.data.status ?? "todo",
    priority: parsed.data.priority ?? "medium",
    taskType: parsed.data.taskType ?? "other",
    effortLevel: parsed.data.effortLevel ?? "m",
    tags: parsed.data.tags ?? [],
    dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
    assignedDeploymentId: parsed.data.assignedAgentId ?? null,
    parentTaskId: null,
    createdByUserId: req.user!.userId,
    createdByDeploymentId: null,
    acceptanceCriteria: null,
  });

  const names = await agentNameMap(companyId);
  res.status(StatusCodes.CREATED).json({
    task: toTaskDTO(
      row,
      row.assignedDeploymentId
        ? (names.get(row.assignedDeploymentId) ?? null)
        : null,
    ),
  });

  void appendTaskEventBestEffort({
    companyId,
    taskId: row.id,
    eventType: "task_created",
    actorType: "user",
    actorId: req.user!.userId,
    payload: {
      title: row.title,
      taskType: row.taskType,
      parentTaskId: row.parentTaskId ?? null,
    },
  });
  if (row.assignedDeploymentId) {
    void appendTaskEventBestEffort({
      companyId,
      taskId: row.id,
      eventType: "task_assigned",
      actorType: "user",
      actorId: req.user!.userId,
      payload: { deploymentId: row.assignedDeploymentId },
    });
    enqueueTaskDispatch(row.id).catch((err) =>
      log.error({ err, taskId: row.id }, "enqueue task dispatch failed"),
    );
  }
});

router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const parsed = updateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_BODY,
      detail: parsed.error.flatten(),
    });
    return;
  }
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }

  const existing = await findTaskInCompany(req.params.id, companyId);
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TASK_NOT_FOUND });
    return;
  }

  // Archived tasks are read-only — must unarchive before editing.
  if (existing.archivedAt) {
    res.status(StatusCodes.LOCKED).json({
      error: ERROR_CODES.TASK_ARCHIVED,
      reason: "Task is archived. Unarchive it before editing.",
    });
    return;
  }

  // Lock: while agent is running, only allow status/blocks updates (from
  // dispatcher itself). Reject user edits to title, agent assignment, etc.
  const isDispatcherUpdate =
    existing.status === "in_progress" &&
    existing.linkedTraceId !== null &&
    parsed.data.status !== undefined &&
    Object.keys(parsed.data).every((k) => ["status", "blocks"].includes(k));

  if (existing.status === "in_progress" && existing.linkedTraceId) {
    if (!isDispatcherUpdate) {
      res.status(StatusCodes.LOCKED).json({
        error: ERROR_CODES.TASK_LOCKED,
        reason: "Agent is currently working on this task",
      });
      return;
    }
  }

  // FSM: reject manual transitions that would put the task into an
  // inconsistent state (e.g. user setting `in_progress` without dispatch,
  // or walking `done` back into a working state). Dispatcher path bypasses
  // because it's the system, not a user override. The cast on
  // `existing.status` is safe — schema-level CHECK keeps the column to
  // valid `TaskStatus` values, but drizzle types it as `string`.
  if (
    parsed.data.status !== undefined &&
    parsed.data.status !== existing.status &&
    !isDispatcherUpdate
  ) {
    if (
      !isUserStatusTransitionAllowed(
        existing.status as TaskStatus,
        parsed.data.status,
      )
    ) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.INVALID_STATUS_TRANSITION,
        from: existing.status,
        to: parsed.data.status,
      });
      return;
    }
  }

  if (
    parsed.data.assignedAgentId !== undefined &&
    parsed.data.assignedAgentId !== existing.assignedDeploymentId
  ) {
    res.status(StatusCodes.FORBIDDEN).json({
      error: ERROR_CODES.TASK_REASSIGN_DISABLED,
      reason:
        "Reassigning a task to a different agent is disabled. Cross-agent context handoff is not yet implemented.",
    });
    return;
  }

  const fields: Parameters<typeof updateTask>[1] = {};
  if (parsed.data.title !== undefined) fields.title = parsed.data.title;
  if (parsed.data.blocks !== undefined) fields.blocks = parsed.data.blocks;
  if (parsed.data.status !== undefined) fields.status = parsed.data.status;
  if (parsed.data.priority !== undefined) fields.priority = parsed.data.priority;
  if (parsed.data.taskType !== undefined) fields.taskType = parsed.data.taskType;
  if (parsed.data.effortLevel !== undefined)
    fields.effortLevel = parsed.data.effortLevel;
  if (parsed.data.tags !== undefined) fields.tags = parsed.data.tags;
  if (parsed.data.dueDate !== undefined) {
    fields.dueDate = parsed.data.dueDate ? new Date(parsed.data.dueDate) : null;
  }
  if (parsed.data.assignedAgentId !== undefined) {
    fields.assignedDeploymentId = parsed.data.assignedAgentId;
  }

  const row = await updateTask(existing.id, fields);
  if (!row) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TASK_NOT_FOUND });
    return;
  }

  const names = await agentNameMap(companyId);
  res.json({
    task: toTaskDTO(
      row,
      row.assignedDeploymentId
        ? (names.get(row.assignedDeploymentId) ?? null)
        : null,
    ),
  });

  if (
    parsed.data.status !== undefined &&
    parsed.data.status !== existing.status
  ) {
    void appendTaskEventBestEffort({
      companyId,
      taskId: row.id,
      eventType: "task_status_changed",
      actorType: "user",
      actorId: req.user!.userId,
      payload: {
        from: existing.status,
        to: row.status,
        reason: "user_edit",
      },
    });
  }
});

router.post("/:id/rerun", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const existing = await findTaskInCompany(req.params.id, companyId);
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TASK_NOT_FOUND });
    return;
  }
  if (!existing.assignedDeploymentId) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.NO_AGENT_ASSIGNED });
    return;
  }
  if (existing.status === "in_progress" && existing.linkedTraceId) {
    res.status(StatusCodes.LOCKED).json({
      error: ERROR_CODES.TASK_LOCKED,
      reason: "Agent is already working on this task",
    });
    return;
  }

  const names = await agentNameMap(companyId);
  res.json({
    task: toTaskDTO(
      existing,
      existing.assignedDeploymentId
        ? (names.get(existing.assignedDeploymentId) ?? null)
        : null,
    ),
  });

  enqueueTaskDispatch(existing.id).catch((err) =>
    log.error({ err, taskId: existing.id }, "enqueue task dispatch failed"),
  );
});

router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const deleted = await deleteTaskInCompany(req.params.id, companyId);
  if (!deleted) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TASK_NOT_FOUND });
    return;
  }
  res.status(StatusCodes.OK).json({ ok: true });
});

export default router;
