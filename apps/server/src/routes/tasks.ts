import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { LIMITS } from "../lib/limits";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../infra/database/client";
import {
  agentIdentities,
  companies,
  deployments,
  tasks,
} from "@occa/shared/schema";
import {
  EFFORT_LEVELS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type ContentBlock,
  type EffortLevel,
  type ListTaskCommentsResponse,
  type TaskCommentResponse,
  type TaskDTO,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from "@occa/shared/types";
import { requireAuth } from "../middleware/auth";
import { requireAgentToken } from "../middleware/agent-auth";
import { enqueueTaskDispatch } from "../infra/queue/task-worker";
import { createTaskComment, listTaskComments } from "../services/task-comments";
import { childLogger } from "../lib/logger";

const log = childLogger("routes:tasks");

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

// Names live on `agent_identities`, not on the deployment row — JOIN to
// surface them for the per-company assigned-agent name map.
async function agentNameMap(companyId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: deployments.id, name: agentIdentities.name })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(eq(deployments.companyId, companyId));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function toDTO(
  row: typeof tasks.$inferSelect,
  agentName: string | null,
): TaskDTO {
  return {
    id: row.id,
    companyId: row.companyId,
    taskNumber: row.taskNumber,
    assignedAgentId: row.assignedDeploymentId,
    assignedAgentName: agentName,
    title: row.title,
    blocks: (row.blocks as ContentBlock[]) ?? [],
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    taskType: row.taskType as TaskType,
    effortLevel: row.effortLevel as EffortLevel,
    tags: row.tags ?? [],
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    linkedTraceId: row.linkedTraceId ?? null,
    parentTaskId: row.parentTaskId ?? null,
    blockedByTaskIds: row.blockedByTaskIds ?? [],
    createdByUserId: row.createdByUserId ?? null,
    createdByAgentId: row.createdByDeploymentId ?? null,
    acceptanceCriteria: row.acceptanceCriteria ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const contentBlockSchema: z.ZodType<ContentBlock> = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("paragraph"), text: z.string() }),
    z.object({ type: z.literal("heading_1"), text: z.string() }),
    z.object({ type: z.literal("heading_2"), text: z.string() }),
    z.object({ type: z.literal("heading_3"), text: z.string() }),
    z.object({ type: z.literal("bullet"), text: z.string() }),
    z.object({
      type: z.literal("checklist"),
      text: z.string(),
      checked: z.boolean(),
    }),
    z.object({ type: z.literal("quote"), text: z.string() }),
    z.object({ type: z.literal("code"), text: z.string() }),
    z.object({ type: z.literal("divider") }),
    z.object({
      type: z.literal("agent_result"),
      traceId: z.string().uuid(),
      agentId: z.string().uuid(),
      agentName: z.string(),
      timestamp: z.string().datetime(),
      preview: z.string(),
    }),
  ],
);

const createBody = z.object({
  title: z.string().trim().min(1).max(LIMITS.TITLE),
  blocks: z.array(contentBlockSchema).max(LIMITS.TASK_BLOCKS_MAX).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  taskType: z.enum(TASK_TYPES).optional(),
  effortLevel: z.enum(EFFORT_LEVELS).optional(),
  tags: z.array(z.string().trim().min(1).max(LIMITS.TAG)).max(LIMITS.TAGS_MAX).optional(),
  dueDate: z.string().datetime().nullable().optional(),
  assignedAgentId: z.string().uuid().nullable().optional(),
});

const updateBody = createBody.partial();

async function verifyAgent(
  companyId: string,
  deploymentId: string | null | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!deploymentId) return { ok: true };
  const [row] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.id, deploymentId),
        eq(deployments.companyId, companyId),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, reason: "agent_not_in_company" };
  return { ok: true };
}

// GET /api/tasks
router.get("/", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.companyId, companyId))
    .orderBy(desc(tasks.updatedAt));
  const names = await agentNameMap(companyId);
  res.json({
    tasks: rows.map((r) =>
      toDTO(
        r,
        r.assignedDeploymentId
          ? (names.get(r.assignedDeploymentId) ?? null)
          : null,
      ),
    ),
  });
});

// POST /api/tasks
router.post("/", requireAuth, async (req: Request, res: Response) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }

  const agentCheck = await verifyAgent(companyId, parsed.data.assignedAgentId);
  if (!agentCheck.ok) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: agentCheck.reason });
    return;
  }

  // Allocate the per-company task number atomically inside a transaction so
  // concurrent creates can't collide on the unique (company_id, task_number)
  // index. We take a row lock on the company as the serialization point — it
  // keeps the calculation simple without a dedicated sequence per tenant.
  const row = await db.transaction(async (tx) => {
    await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("update");
    const { rows } = await tx.execute<{ next: number }>(
      sql`SELECT COALESCE(MAX(task_number), 0) + 1 AS next FROM tasks WHERE company_id = ${companyId}`,
    );
    const next = rows[0]?.next ?? 1;
    const [inserted] = await tx
      .insert(tasks)
      .values({
        companyId,
        taskNumber: next,
        assignedDeploymentId: parsed.data.assignedAgentId ?? null,
        title: parsed.data.title,
        blocks: parsed.data.blocks ?? [],
        status: parsed.data.status ?? "todo",
        priority: parsed.data.priority ?? "medium",
        taskType: parsed.data.taskType ?? "other",
        effortLevel: parsed.data.effortLevel ?? "m",
        tags: parsed.data.tags ?? [],
        dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
        createdByUserId: req.user!.userId,
      })
      .returning();
    return inserted;
  });

  const names = await agentNameMap(companyId);
  res.status(StatusCodes.CREATED).json({
    task: toDTO(
      row,
      row.assignedDeploymentId
        ? (names.get(row.assignedDeploymentId) ?? null)
        : null,
    ),
  });

  // Queue dispatch if assigned on creation. Response already flushed above;
  // enqueue errors just log — they don't impact the HTTP response.
  if (row.assignedDeploymentId) {
    enqueueTaskDispatch(row.id).catch((err) =>
      log.error({ err, taskId: row.id }, "enqueue task dispatch failed"),
    );
  }
});

// PATCH /api/tasks/:id
router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const parsed = updateBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }

  const [existing] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, req.params.id), eq(tasks.companyId, companyId)))
    .limit(1);
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TASK_NOT_FOUND });
    return;
  }

  // Lock: while agent is running, only allow status/blocks updates (from dispatcher itself).
  // Reject user edits to title, agent assignment, priority, etc.
  if (existing.status === "in_progress" && existing.linkedTraceId) {
    const isDispatcherUpdate =
      parsed.data.status !== undefined &&
      Object.keys(parsed.data).every((k) => ["status", "blocks"].includes(k));
    if (!isDispatcherUpdate) {
      res
        .status(StatusCodes.LOCKED)
        .json({
          error: ERROR_CODES.TASK_LOCKED,
          reason: "Agent is currently working on this task",
        });
      return;
    }
  }

  if (parsed.data.assignedAgentId !== undefined) {
    const agentCheck = await verifyAgent(
      companyId,
      parsed.data.assignedAgentId,
    );
    if (!agentCheck.ok) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: agentCheck.reason });
      return;
    }
  }

  const updates: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (parsed.data.blocks !== undefined) updates.blocks = parsed.data.blocks;
  if (parsed.data.status !== undefined) updates.status = parsed.data.status;
  if (parsed.data.priority !== undefined)
    updates.priority = parsed.data.priority;
  if (parsed.data.taskType !== undefined)
    updates.taskType = parsed.data.taskType;
  if (parsed.data.effortLevel !== undefined)
    updates.effortLevel = parsed.data.effortLevel;
  if (parsed.data.tags !== undefined) updates.tags = parsed.data.tags;
  if (parsed.data.dueDate !== undefined) {
    updates.dueDate = parsed.data.dueDate
      ? new Date(parsed.data.dueDate)
      : null;
  }
  if (parsed.data.assignedAgentId !== undefined) {
    updates.assignedDeploymentId = parsed.data.assignedAgentId;
  }

  const [row] = await db
    .update(tasks)
    .set(updates)
    .where(eq(tasks.id, existing.id))
    .returning();

  const names = await agentNameMap(companyId);
  res.json({
    task: toDTO(
      row,
      row.assignedDeploymentId
        ? (names.get(row.assignedDeploymentId) ?? null)
        : null,
    ),
  });

  // Queue dispatch when agent is newly assigned.
  const agentJustAssigned =
    parsed.data.assignedAgentId &&
    parsed.data.assignedAgentId !== existing.assignedDeploymentId &&
    row.status !== "in_progress";
  if (agentJustAssigned) {
    enqueueTaskDispatch(row.id).catch((err) =>
      log.error({ err, taskId: row.id }, "enqueue task dispatch failed"),
    );
  }
});

// POST /api/tasks/:id/rerun
router.post("/:id/rerun", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const [existing] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, req.params.id), eq(tasks.companyId, companyId)))
    .limit(1);
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TASK_NOT_FOUND });
    return;
  }
  if (!existing.assignedDeploymentId) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.NO_AGENT_ASSIGNED });
    return;
  }
  if (existing.status === "in_progress" && existing.linkedTraceId) {
    res
      .status(StatusCodes.LOCKED)
      .json({
        error: ERROR_CODES.TASK_LOCKED,
        reason: "Agent is already working on this task",
      });
    return;
  }

  const names = await agentNameMap(companyId);
  res.json({
    task: toDTO(
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

// DELETE /api/tasks/:id
router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const [deleted] = await db
    .delete(tasks)
    .where(and(eq(tasks.id, req.params.id), eq(tasks.companyId, companyId)))
    .returning({ id: tasks.id });
  if (!deleted) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TASK_NOT_FOUND });
    return;
  }
  res.status(StatusCodes.OK).json({ ok: true });
});

// ── Task comments — agent ↔ user thread per task ─────────────────────────────
//
// Two auth surfaces:
//   * GET / POST /api/tasks/:id/comments         — user JWT (board / human)
//   * GET / POST /api/agents/me/tasks/:id/comments — agent token (the agent
//     itself, used for ASK action and direct programmatic posting)
//
// Both write into the same `task_comments` table; the difference is which
// `author_*` column gets populated. The service handles `@<agent-name>`
// parsing + wake-on-mention identically.

const commentBody = z.object({
  body: z.string().trim().min(1).max(LIMITS.DESCRIPTION),
});

// USER → list comments on a task they own.
router.get(
  "/:id/comments",
  requireAuth,
  async (req: Request, res: Response) => {
    const companyId = await userCompanyId(req.user!.userId);
    if (!companyId) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }
    // Confirm the task belongs to user's company.
    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, req.params.id), eq(tasks.companyId, companyId)))
      .limit(1);
    if (!task) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TASK_NOT_FOUND });
      return;
    }
    const comments = await listTaskComments(req.params.id, companyId);
    const body: ListTaskCommentsResponse = { comments };
    res.json(body);
  },
);

// USER → post a comment on a task. `@<agent-name>` tokens in the body
// resolve to wakes for the matching agent(s).
router.post(
  "/:id/comments",
  requireAuth,
  async (req: Request, res: Response) => {
    const companyId = await userCompanyId(req.user!.userId);
    if (!companyId) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }
    const parsed = commentBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
      return;
    }
    try {
      const result = await createTaskComment({
        taskId: req.params.id,
        companyId,
        authorUserId: req.user!.userId,
        body: parsed.data.body,
      });
      const body: TaskCommentResponse = { comment: result.comment };
      res.status(StatusCodes.CREATED).json(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "comment_failed";
      if (msg.startsWith("comment_task_not_in_company")) {
        res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TASK_NOT_FOUND });
        return;
      }
      log.error({ err }, "user comment insert failed");
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: ERROR_CODES.COMMENT_FAILED });
    }
  },
);

// AGENT → list comments on any task in its own company. Same content as
// the user-facing GET; provided so an agent can read prior thread state
// before deciding whether to ASK or BLOCK.
router.get(
  "/me/:id/comments",
  requireAgentToken,
  async (req: Request, res: Response) => {
    const { companyId } = req.agent!;
    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, req.params.id), eq(tasks.companyId, companyId)))
      .limit(1);
    if (!task) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TASK_NOT_FOUND });
      return;
    }
    const comments = await listTaskComments(req.params.id, companyId);
    const body: ListTaskCommentsResponse = { comments };
    res.json(body);
  },
);

// AGENT → post a comment as itself. Auth via agent token; authorAgentId
// is server-determined from the token. Used for programmatic ASK posts
// when the agent prefers HTTP over the [[OCCA:ASK]] marker channel.
router.post(
  "/me/:id/comments",
  requireAgentToken,
  async (req: Request, res: Response) => {
    const { agentId, companyId } = req.agent!;
    const parsed = commentBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
      return;
    }
    try {
      const result = await createTaskComment({
        taskId: req.params.id,
        companyId,
        authorAgentId: agentId,
        body: parsed.data.body,
      });
      const body: TaskCommentResponse = { comment: result.comment };
      res.status(StatusCodes.CREATED).json(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "comment_failed";
      if (msg.startsWith("comment_task_not_in_company")) {
        res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TASK_NOT_FOUND });
        return;
      }
      log.error({ err }, "agent comment insert failed");
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: ERROR_CODES.COMMENT_FAILED });
    }
  },
);

export default router;
