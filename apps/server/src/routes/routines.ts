import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { LIMITS } from "../lib/limits";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import {
  agents,
  companies,
  routineTriggers,
  routines,
} from "@occa/shared/schema";
import {
  ROUTINE_STATUSES,
  ROUTINE_TRIGGER_KINDS,
  type ListRoutinesResponse,
  type RoutineDTO,
  type RoutineResponse,
  type RoutineTriggerDTO,
  type RoutineTriggerKind,
} from "@occa/shared/types";
import { db } from "../infra/database/client";
import { requireAuth } from "../middleware/auth";

const router: Router = Router();

async function userCompanyId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(
        eq(companies.ownerUserId, userId),
        eq(companies.kind, "user"),
        isNull(companies.deletedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

function toTriggerDTO(
  row: typeof routineTriggers.$inferSelect,
): RoutineTriggerDTO {
  return {
    id: row.id,
    routineId: row.routineId,
    kind: row.kind as RoutineTriggerKind,
    label: row.label ?? null,
    enabled: row.enabled,
    cronExpression: row.cronExpression ?? null,
    timezone: row.timezone ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
  };
}

function toRoutineDTO(
  row: typeof routines.$inferSelect,
  triggers: RoutineTriggerDTO[],
): RoutineDTO {
  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title,
    description: row.description ?? null,
    assigneeAgentId: row.assigneeAgentId ?? null,
    priority: row.priority,
    status: row.status,
    concurrencyPolicy: row.concurrencyPolicy,
    catchUpPolicy: row.catchUpPolicy,
    variables: (row.variables as Record<string, unknown> | null) ?? null,
    lastTriggeredAt: row.lastTriggeredAt?.toISOString() ?? null,
    lastEnqueuedAt: row.lastEnqueuedAt?.toISOString() ?? null,
    triggers,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function computeNextRun(
  cronExpression: string,
  timezone: string | null,
): Date | null {
  try {
    const iter = CronExpressionParser.parse(cronExpression, {
      tz: timezone ?? undefined,
    });
    return iter.next().toDate();
  } catch {
    return null;
  }
}

async function loadRoutine(
  companyId: string,
  routineId: string,
): Promise<RoutineDTO | null> {
  const [row] = await db
    .select()
    .from(routines)
    .where(
      and(eq(routines.id, routineId), eq(routines.companyId, companyId)),
    )
    .limit(1);
  if (!row) return null;
  const triggers = await db
    .select()
    .from(routineTriggers)
    .where(eq(routineTriggers.routineId, row.id));
  return toRoutineDTO(row, triggers.map(toTriggerDTO));
}

async function verifyAssignee(
  companyId: string,
  agentId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .limit(1);
  return !!row;
}

// ── Schemas ─────────────────────────────────────────────────────────────
const triggerInputBase = z.object({
  kind: z.enum(ROUTINE_TRIGGER_KINDS),
  label: z.string().max(LIMITS.LABEL).optional(),
  enabled: z.boolean().optional(),
  cronExpression: z.string().max(LIMITS.LABEL).optional(),
  timezone: z.string().max(LIMITS.TIMEZONE).optional(),
});

function validateTriggerInput(input: z.infer<typeof triggerInputBase>): {
  ok: boolean;
  error?: string;
} {
  if (input.kind === "cron") {
    if (!input.cronExpression) return { ok: false, error: ERROR_CODES.CRON_REQUIRED };
    try {
      CronExpressionParser.parse(input.cronExpression, {
        tz: input.timezone,
      });
    } catch {
      return { ok: false, error: ERROR_CODES.INVALID_CRON_EXPRESSION };
    }
  }
  return { ok: true };
}

const createRoutineBody = z.object({
  title: z.string().trim().min(1).max(LIMITS.KEY),
  description: z.string().max(LIMITS.DESCRIPTION_LONG).optional(),
  assigneeAgentId: z.string().uuid(),
  priority: z.string().max(LIMITS.TINY).optional(),
  triggers: z.array(triggerInputBase).min(1).max(LIMITS.TRIGGERS_MAX),
});

const updateRoutineBody = z.object({
  title: z.string().trim().min(1).max(LIMITS.KEY).optional(),
  description: z.string().max(LIMITS.DESCRIPTION_LONG).optional(),
  assigneeAgentId: z.string().uuid().optional(),
  priority: z.string().max(LIMITS.TINY).optional(),
  status: z.enum(ROUTINE_STATUSES).optional(),
});

// ── Routes ──────────────────────────────────────────────────────────────

// GET /api/routines
router.get("/", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const rows = await db
    .select()
    .from(routines)
    .where(eq(routines.companyId, companyId));
  const ids = rows.map((r) => r.id);
  const allTriggers = ids.length
    ? await db
        .select()
        .from(routineTriggers)
        .where(inArray(routineTriggers.routineId, ids))
    : [];
  const byRoutine = new Map<string, RoutineTriggerDTO[]>();
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
  const okAgent = await verifyAssignee(companyId, parsed.data.assigneeAgentId);
  if (!okAgent) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.AGENT_NOT_FOUND });
    return;
  }
  for (const t of parsed.data.triggers) {
    const v = validateTriggerInput(t);
    if (!v.ok) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: v.error });
      return;
    }
  }

  const routineId = await db.transaction(async (tx) => {
    const [rtn] = await tx
      .insert(routines)
      .values({
        companyId,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        assigneeAgentId: parsed.data.assigneeAgentId,
        priority: parsed.data.priority ?? "medium",
      })
      .returning({ id: routines.id });

    for (const t of parsed.data.triggers) {
      await tx.insert(routineTriggers).values({
        routineId: rtn.id,
        kind: t.kind,
        label: t.label ?? null,
        enabled: t.enabled ?? true,
        cronExpression: t.cronExpression ?? null,
        timezone: t.timezone ?? null,
        nextRunAt:
          t.kind === "cron" && t.cronExpression
            ? computeNextRun(t.cronExpression, t.timezone ?? null)
            : null,
      });
    }
    return rtn.id;
  });

  const dto = await loadRoutine(companyId, routineId);
  const body: RoutineResponse = { routine: dto! };
  res.status(StatusCodes.CREATED).json(body);
});

// GET /api/routines/:id
router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const dto = await loadRoutine(companyId, req.params.id);
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
  const update: Partial<typeof routines.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (parsed.data.title !== undefined) update.title = parsed.data.title;
  if (parsed.data.description !== undefined)
    update.description = parsed.data.description;
  if (parsed.data.priority !== undefined) update.priority = parsed.data.priority;
  if (parsed.data.status !== undefined) update.status = parsed.data.status;
  if (parsed.data.assigneeAgentId !== undefined) {
    const okAgent = await verifyAssignee(companyId, parsed.data.assigneeAgentId);
    if (!okAgent) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }
    update.assigneeAgentId = parsed.data.assigneeAgentId;
  }
  const [row] = await db
    .update(routines)
    .set(update)
    .where(and(eq(routines.id, req.params.id), eq(routines.companyId, companyId)))
    .returning({ id: routines.id });
  if (!row) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  const dto = await loadRoutine(companyId, row.id);
  res.json({ routine: dto! } satisfies RoutineResponse);
});

// DELETE /api/routines/:id
router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const [row] = await db
    .delete(routines)
    .where(and(eq(routines.id, req.params.id), eq(routines.companyId, companyId)))
    .returning({ id: routines.id });
  if (!row) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  res.json({ ok: true });
});

// ── Triggers ────────────────────────────────────────────────────────────
async function ownsRoutine(
  companyId: string,
  routineId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: routines.id })
    .from(routines)
    .where(and(eq(routines.id, routineId), eq(routines.companyId, companyId)))
    .limit(1);
  return !!row;
}

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
      res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    const v = validateTriggerInput(parsed.data);
    if (!v.ok) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: v.error });
      return;
    }
    const [row] = await db
      .insert(routineTriggers)
      .values({
        routineId: req.params.id,
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
      })
      .returning();
    res.status(StatusCodes.CREATED).json({ trigger: toTriggerDTO(row) });
  },
);

const updateTriggerBody = z.object({
  label: z.string().max(LIMITS.LABEL).optional(),
  enabled: z.boolean().optional(),
  cronExpression: z.string().max(LIMITS.LABEL).optional(),
  timezone: z.string().max(LIMITS.TIMEZONE).optional(),
});

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
      res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    if (parsed.data.cronExpression !== undefined) {
      try {
        CronExpressionParser.parse(parsed.data.cronExpression, {
          tz: parsed.data.timezone,
        });
      } catch {
        res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_CRON_EXPRESSION });
        return;
      }
    }
    const update: Partial<typeof routineTriggers.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (parsed.data.label !== undefined) update.label = parsed.data.label;
    if (parsed.data.enabled !== undefined) update.enabled = parsed.data.enabled;
    if (parsed.data.cronExpression !== undefined) {
      update.cronExpression = parsed.data.cronExpression;
      update.nextRunAt = computeNextRun(
        parsed.data.cronExpression,
        parsed.data.timezone ?? null,
      );
    }
    if (parsed.data.timezone !== undefined) update.timezone = parsed.data.timezone;

    const [row] = await db
      .update(routineTriggers)
      .set(update)
      .where(
        and(
          eq(routineTriggers.id, req.params.tid),
          eq(routineTriggers.routineId, req.params.id),
        ),
      )
      .returning();
    if (!row) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TRIGGER_NOT_FOUND });
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
    const [row] = await db
      .delete(routineTriggers)
      .where(
        and(
          eq(routineTriggers.id, req.params.tid),
          eq(routineTriggers.routineId, req.params.id),
        ),
      )
      .returning({ id: routineTriggers.id });
    if (!row) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TRIGGER_NOT_FOUND });
      return;
    }
    res.json({ ok: true });
  },
);

export default router;
