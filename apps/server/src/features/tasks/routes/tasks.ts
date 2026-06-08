// Task CRUD routes — user JWT authenticated. Mounted under /api/tasks.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import type { TaskDTO, TaskStatus } from "@occa/shared/types";
import { TASK_STATUSES } from "@occa/shared/types";
import { childLogger } from "../../../lib/logger";
import { LIMITS } from "../../../lib/limits";
import { requireAuth } from "../../../middleware/auth";
import { enqueueTaskDispatch } from "../../../infra/queue/task-worker";
import { createTaskRecord } from "../../../infra/database/task-creation";
import {
  agentNameMap,
  deleteTaskInCompany,
  findTaskInCompany,
  listTasksByCompany,
  taskStatusCounts,
  updateTask,
} from "../repositories/tasks";
import { findCeoForCompany } from "../../agents/repositories/deployments";
import { createTaskBody, updateTaskBody } from "../domain/schemas";
import { isUserStatusTransitionAllowed } from "../domain/status-transitions";
import { appendTaskEventBestEffort } from "../services/events";
import { ensureInvoiceForCompletedTask } from "../../billing/services/invoice-on-task-complete";
import { toTaskDTO, userCompanyId } from "./helpers";

const log = childLogger("routes:tasks");

const router: Router = Router();

router.get("/", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }

  // `include_archived=1` mixes archived rows in; `archived=1` returns ONLY
  // archived (the board's Archived column). Default is active-only.
  const includeArchived = req.query.include_archived === "1";
  const archivedOnly = req.query.archived === "1";

  // Optional single-status column filter (validated against the enum).
  const statusParam =
    typeof req.query.status === "string" ? req.query.status : undefined;
  if (statusParam && !TASK_STATUSES.includes(statusParam as TaskStatus)) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_BODY, detail: "unknown status" });
    return;
  }
  const status = statusParam as TaskStatus | undefined;

  // Pagination is opt-in: presence of `limit` switches to a single page.
  // Absent → legacy full list (keeps the pre-pagination client working).
  const paginated = typeof req.query.limit === "string";
  let limit: number | undefined;
  let offset = 0;
  if (paginated) {
    const parsedLimit = Number.parseInt(req.query.limit as string, 10);
    limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), LIMITS.TASK_PAGE_SIZE)
      : LIMITS.TASK_PAGE_SIZE;
    const parsedOffset = Number.parseInt(String(req.query.offset ?? ""), 10);
    offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
  }

  // Fetch one extra row to detect a next page without a second count query.
  const rows = await listTasksByCompany(companyId, {
    includeArchived,
    archivedOnly,
    status,
    ...(paginated ? { limit: limit! + 1, offset } : {}),
  });

  const hasMore = paginated && rows.length > limit!;
  const pageRows = paginated && hasMore ? rows.slice(0, limit!) : rows;

  const names = await agentNameMap(companyId);
  const tasksDto: TaskDTO[] = pageRows.map((r) =>
    toTaskDTO(
      r,
      r.assignedDeploymentId
        ? (names.get(r.assignedDeploymentId) ?? null)
        : null,
    ),
  );
  res.json(paginated ? { tasks: tasksDto, hasMore } : { tasks: tasksDto });
});

// Per-status counts for the board column headers. Cheap aggregate — stays
// accurate no matter how many tasks exist, so headers don't depend on how
// many cards the client has paged in.
router.get("/counts", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const { byStatus, archived } = await taskStatusCounts(companyId);
  res.json({ counts: byStatus, archived });
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

  // Phase 2 entry lock: every user-created top-level task routes through
  // the company's CEO. The agent picker on the FE is removed; any
  // `assignedAgentId` arriving from a stale client is ignored (the schema
  // still accepts the field for non-breaking back-compat with child-task
  // flows that may reuse the same body shape later). If the company has
  // no active CEO, we error so the user deploys one before creating tasks.
  const ceo = await findCeoForCompany(companyId);
  if (!ceo) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.NO_CEO_DEPLOYED,
      reason:
        "Deploy a CEO agent before creating tasks. The CEO is the entry point for all user requests.",
    });
    return;
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
    assignedDeploymentId: ceo.id,
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
  if (parsed.data.resultUri !== undefined) {
    // Normalize empty string to null — a cleared field means "no public URL".
    fields.resultUri = parsed.data.resultUri ? parsed.data.resultUri : null;
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
    // Phase 1b-ii: a manual move to `done` bills the company too, same as
    // the autonomous dispatcher path. Idempotent — the unique index keeps
    // it to one invoice per task even if the dispatcher also fired.
    if (row.status === "done") {
      void ensureInvoiceForCompletedTask({ taskId: row.id }).catch((err) => {
        req.log.error(
          { err, taskId: row.id },
          "ensureInvoiceForCompletedTask failed (non-fatal)",
        );
      });
    }
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
