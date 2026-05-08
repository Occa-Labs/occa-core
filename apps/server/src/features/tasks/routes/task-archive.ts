// Archive / unarchive routes. Soft-state only — no rows leave the DB.
// Mounted under /api/tasks. User-JWT authenticated.
//
// Archive does NOT change the task's `status` field — `status` is the
// workflow position (todo/in_progress/review/done/blocked), `archivedAt`
// is the orthogonal "is this task shelved?" axis. This separation keeps
// reporting honest: "done" really means completed, "archived" means
// abandoned/wont-fix.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { LIMITS } from "../../../lib/limits";
import { StatusCodes } from "http-status-codes";
import type { TaskDTO } from "@occa/shared/types";
import { childLogger } from "../../../lib/logger";
import { requireAuth } from "../../../middleware/auth";
import {
  agentNameMap,
  archiveTask,
  findTaskInCompany,
  unarchiveTask,
} from "../repositories/tasks";
import { appendTaskEventBestEffort } from "../services/events";
import { toTaskDTO, userCompanyId } from "./helpers";

const log = childLogger("routes:tasks:archive");

const archiveBody = z.object({
  reason: z.string().trim().max(LIMITS.REASON).optional(),
});

const router: Router = Router();

router.post("/:id/archive", requireAuth, async (req: Request, res: Response) => {
  const parsed = archiveBody.safeParse(req.body ?? {});
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
  if (existing.archivedAt) {
    res.status(StatusCodes.CONFLICT).json({ error: ERROR_CODES.TASK_ARCHIVED });
    return;
  }

  const reason = parsed.data.reason ?? null;
  const row = await archiveTask(existing.id, reason);
  if (!row) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TASK_NOT_FOUND });
    return;
  }

  const names = await agentNameMap(companyId);
  const dto: TaskDTO = toTaskDTO(
    row,
    row.assignedDeploymentId ? (names.get(row.assignedDeploymentId) ?? null) : null,
  );
  res.json({ task: dto });

  void appendTaskEventBestEffort({
    companyId,
    taskId: row.id,
    eventType: "task_archived",
    actorType: "user",
    actorId: req.user!.userId,
    payload: reason ? { reason } : {},
  });
  log.info({ taskId: row.id, reason }, "task archived");
});

router.post(
  "/:id/unarchive",
  requireAuth,
  async (req: Request, res: Response) => {
    const companyId = await userCompanyId(req.user!.userId);
    if (!companyId) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
      return;
    }
    const existing = await findTaskInCompany(req.params.id, companyId);
    if (!existing) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.TASK_NOT_FOUND });
      return;
    }
    if (!existing.archivedAt) {
      res
        .status(StatusCodes.CONFLICT)
        .json({ error: ERROR_CODES.TASK_NOT_ARCHIVED });
      return;
    }

    const row = await unarchiveTask(existing.id);
    if (!row) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.TASK_NOT_FOUND });
      return;
    }

    const names = await agentNameMap(companyId);
    const dto: TaskDTO = toTaskDTO(
      row,
      row.assignedDeploymentId
        ? (names.get(row.assignedDeploymentId) ?? null)
        : null,
    );
    res.json({ task: dto });

    void appendTaskEventBestEffort({
      companyId,
      taskId: row.id,
      eventType: "task_unarchived",
      actorType: "user",
      actorId: req.user!.userId,
      payload: {},
    });
    log.info({ taskId: row.id }, "task unarchived");
  },
);

export default router;
