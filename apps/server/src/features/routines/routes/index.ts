// Routine CRUD + trigger CRUD, user-JWT surface. Mounted at /api/routines.

import { Router, type Request, type Response } from "express";
import { StatusCodes } from "http-status-codes";
import { ERROR_CODES } from "@occa/shared/error-codes";
import type {
  ListRoutinesResponse,
  RoutineDTO,
  RoutineResponse,
} from "@occa/shared/types";
import { requireAuth } from "../../../middleware/auth";
import {
  computeNextRun,
  isValidCron,
  validateTriggerInput,
} from "../domain/cron";
import {
  createRoutineBody,
  triggerInputBase,
  updateRoutineBody,
  updateTriggerBody,
} from "../domain/schemas";
import {
  createRoutineWithTriggers,
  deleteRoutine,
  deleteTrigger,
  insertTrigger,
  listRoutines,
  listTriggers,
  listTriggersForRoutine,
  loadRoutineRow,
  markTriggersDue,
  ownsRoutine,
  rollDueCronTriggersForward,
  type RoutinePatch,
  type TriggerPatch,
  updateRoutine,
  updateTrigger,
  verifyAssignee,
} from "../repositories/routines";
import { toRoutineDTO, toTriggerDTO, userCompanyId } from "./helpers";

const router: Router = Router();

async function loadRoutineDTO(
  companyId: string,
  routineId: string,
): Promise<RoutineDTO | null> {
  const row = await loadRoutineRow(companyId, routineId);
  if (!row) return null;
  const triggers = await listTriggersForRoutine(row.id);
  return toRoutineDTO(row, triggers.map(toTriggerDTO));
}

// ── Routines ────────────────────────────────────────────────────────────

// GET /api/routines
router.get("/", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const rows = await listRoutines(companyId);
  const allTriggers = await listTriggers(rows.map((r) => r.id));
  const byRoutine = new Map<string, ReturnType<typeof toTriggerDTO>[]>();
  for (const t of allTriggers) {
    const arr = byRoutine.get(t.routineId) ?? [];
    arr.push(toTriggerDTO(t));
    byRoutine.set(t.routineId, arr);
  }
  const body: ListRoutinesResponse = {
    routines: rows.map((r) => toRoutineDTO(r, byRoutine.get(r.id) ?? [])),
  };
  res.json(body);
});

// POST /api/routines
router.post("/", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const parsed = createRoutineBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }
  if (!(await verifyAssignee(companyId, parsed.data.assigneeAgentId))) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
    return;
  }
  for (const t of parsed.data.triggers) {
    const v = validateTriggerInput(t);
    if (!v.ok) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: v.error });
      return;
    }
  }

  const routineId = await createRoutineWithTriggers(
    companyId,
    {
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      assigneeDeploymentId: parsed.data.assigneeAgentId,
      priority: parsed.data.priority ?? "medium",
      workflowYamlId: parsed.data.workflowYamlId
        ? parsed.data.workflowYamlId
        : null,
    },
    parsed.data.triggers.map((t) => ({
      kind: t.kind,
      label: t.label ?? null,
      enabled: t.enabled ?? true,
      cronExpression: t.cronExpression ?? null,
      timezone: t.timezone ?? null,
      nextRunAt:
        t.kind === "cron" && t.cronExpression
          ? computeNextRun(t.cronExpression, t.timezone ?? null)
          : null,
    })),
  );

  const dto = await loadRoutineDTO(companyId, routineId);
  res.status(StatusCodes.CREATED).json({ routine: dto! } satisfies RoutineResponse);
});

// GET /api/routines/:id
router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const dto = await loadRoutineDTO(companyId, req.params.id);
  if (!dto) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  res.json({ routine: dto } satisfies RoutineResponse);
});

// PATCH /api/routines/:id
router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const parsed = updateRoutineBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }
  const patch: RoutinePatch = {};
  if (parsed.data.title !== undefined) patch.title = parsed.data.title;
  if (parsed.data.description !== undefined)
    patch.description = parsed.data.description;
  if (parsed.data.priority !== undefined) patch.priority = parsed.data.priority;
  if (parsed.data.status !== undefined) patch.status = parsed.data.status;
  // Empty string clears the binding back to free-form routine behaviour.
  if (parsed.data.workflowYamlId !== undefined)
    patch.workflowYamlId = parsed.data.workflowYamlId
      ? parsed.data.workflowYamlId
      : null;
  if (parsed.data.assigneeAgentId !== undefined) {
    if (!(await verifyAssignee(companyId, parsed.data.assigneeAgentId))) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }
    patch.assigneeDeploymentId = parsed.data.assigneeAgentId;
  }
  const row = await updateRoutine(companyId, req.params.id, patch);
  if (!row) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }

  // Resuming a routine: roll any past-due cron trigger forward so the next
  // sweep doesn't immediately fire a catch-up run the operator didn't ask
  // for. Shared with the CEO TOGGLE_ROUTINE path.
  if (parsed.data.status === "active") {
    await rollDueCronTriggersForward(req.params.id);
  }

  const dto = await loadRoutineDTO(companyId, row.id);
  res.json({ routine: dto! } satisfies RoutineResponse);
});

// DELETE /api/routines/:id
router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  if (!(await deleteRoutine(companyId, req.params.id))) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  res.json({ ok: true });
});

// POST /api/routines/:id/run — fire now. Marks the routine's cron
// triggers due so the scheduler picks it up on its next tick (≤30s).
router.post("/:id/run", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  if (!(await ownsRoutine(companyId, req.params.id))) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  await markTriggersDue(req.params.id);
  res.json({ ok: true });
});

// ── Triggers ────────────────────────────────────────────────────────────

// POST /api/routines/:id/triggers
router.post(
  "/:id/triggers",
  requireAuth,
  async (req: Request, res: Response) => {
    const companyId = await userCompanyId(req.user!.userId);
    if (!companyId) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
      return;
    }
    if (!(await ownsRoutine(companyId, req.params.id))) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const parsed = triggerInputBase.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    const v = validateTriggerInput(parsed.data);
    if (!v.ok) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: v.error });
      return;
    }
    const row = await insertTrigger(req.params.id, {
      kind: parsed.data.kind,
      label: parsed.data.label ?? null,
      enabled: parsed.data.enabled ?? true,
      cronExpression: parsed.data.cronExpression ?? null,
      timezone: parsed.data.timezone ?? null,
      nextRunAt:
        parsed.data.kind === "cron" && parsed.data.cronExpression
          ? computeNextRun(
              parsed.data.cronExpression,
              parsed.data.timezone ?? null,
            )
          : null,
    });
    res.status(StatusCodes.CREATED).json({ trigger: toTriggerDTO(row) });
  },
);

// PATCH /api/routines/:id/triggers/:tid
router.patch(
  "/:id/triggers/:tid",
  requireAuth,
  async (req: Request, res: Response) => {
    const companyId = await userCompanyId(req.user!.userId);
    if (!companyId) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
      return;
    }
    if (!(await ownsRoutine(companyId, req.params.id))) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const parsed = updateTriggerBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    if (
      parsed.data.cronExpression !== undefined &&
      !isValidCron(parsed.data.cronExpression, parsed.data.timezone)
    ) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_CRON_EXPRESSION });
      return;
    }
    const patch: TriggerPatch = {};
    if (parsed.data.label !== undefined) patch.label = parsed.data.label;
    if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
    if (parsed.data.cronExpression !== undefined) {
      patch.cronExpression = parsed.data.cronExpression;
      patch.nextRunAt = computeNextRun(
        parsed.data.cronExpression,
        parsed.data.timezone ?? null,
      );
    }
    if (parsed.data.timezone !== undefined)
      patch.timezone = parsed.data.timezone;

    const row = await updateTrigger(req.params.id, req.params.tid, patch);
    if (!row) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.TRIGGER_NOT_FOUND });
      return;
    }
    res.json({ trigger: toTriggerDTO(row) });
  },
);

// DELETE /api/routines/:id/triggers/:tid
router.delete(
  "/:id/triggers/:tid",
  requireAuth,
  async (req: Request, res: Response) => {
    const companyId = await userCompanyId(req.user!.userId);
    if (!companyId) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
      return;
    }
    if (!(await ownsRoutine(companyId, req.params.id))) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    if (!(await deleteTrigger(req.params.id, req.params.tid))) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.TRIGGER_NOT_FOUND });
      return;
    }
    res.json({ ok: true });
  },
);

export default router;
