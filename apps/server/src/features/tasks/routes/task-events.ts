// Read-only timeline route for a single task. User-JWT authenticated.
// Mounted under /api/tasks (so the path resolves to
// /api/tasks/:id/events). Append-only invariant means this is purely a
// projection of the underlying log — no PATCH / DELETE here.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import type {
  ListTaskEventsResponse,
  TaskEventActorTypeDTO,
  TaskEventDTO,
  TaskEventTypeDTO,
} from "@occa/shared/types";
import { requireAuth } from "../../../middleware/auth";
import { findTaskInCompany } from "../repositories/tasks";
import {
  listTaskEvents,
  type TaskEventRow,
} from "../repositories/task-events";
import { userCompanyId } from "./helpers";

const router: Router = Router();

function toTaskEventDTO(row: TaskEventRow): TaskEventDTO {
  return {
    id: row.id,
    taskId: row.taskId,
    sequence: row.sequence,
    eventType: row.eventType as TaskEventTypeDTO,
    actorType: row.actorType as TaskEventActorTypeDTO,
    actorId: row.actorId ?? null,
    payload: (row.payload as Record<string, unknown>) ?? {},
    traceId: row.traceId ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

router.get(
  "/:id/events",
  requireAuth,
  async (req: Request, res: Response) => {
    const companyId = await userCompanyId(req.user!.userId);
    if (!companyId) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }
    const task = await findTaskInCompany(req.params.id, companyId);
    if (!task) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.TASK_NOT_FOUND });
      return;
    }
    const rows = await listTaskEvents(req.params.id);
    const body: ListTaskEventsResponse = {
      events: rows.map(toTaskEventDTO),
    };
    res.json(body);
  },
);

export default router;
