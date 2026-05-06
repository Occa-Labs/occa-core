// Trace listings for a single agent — flat per-trace and grouped activity
// (chats / tasks / skill-syncs / one-off traces). Both are read-only and
// share the same `traces` cursor pagination semantics.

import { Router, type Request, type Response } from "express";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { tasks, traces } from "@occa/shared/schema";
import type {
  ActivityGroup,
  ActivityTraceRef,
  ListActivityResponse,
  ListTracesResponse,
  TraceStatus,
  WakeSource,
} from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import { findOwnedByUserId } from "../repositories/deployments";
import { requireAuth } from "../../../middleware/auth";
import {
  listAgentActivityQuery,
  listAgentTracesQuery,
} from "../domain/schemas";
import { toTraceDTO } from "../domain/dtos";

const router: Router = Router();

// GET /api/agents/:id/traces?limit=N&cursor=<iso>
router.get("/:id/traces", requireAuth, async (req: Request, res: Response) => {
  const existing = await findOwnedByUserId({
    userId: req.user!.userId,
    deploymentId: req.params.id,
  });
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  const q = listAgentTracesQuery.safeParse(req.query);
  if (!q.success) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_QUERY });
    return;
  }
  const limit = q.data.limit ?? 50;
  const conditions = [eq(traces.deploymentId, existing.id)];
  if (q.data.cursor) {
    conditions.push(lt(traces.createdAt, new Date(q.data.cursor)));
  }
  const rows = await db
    .select()
    .from(traces)
    .where(and(...conditions))
    .orderBy(desc(traces.createdAt))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore
    ? page[page.length - 1].createdAt.toISOString()
    : null;
  const body: ListTracesResponse = {
    traces: page.map(toTraceDTO),
    nextCursor,
  };
  res.json(body);
});

// GET /api/agents/:id/activity?limit=N&cursor=<iso>
// Returns traces grouped by context: conversationId (chat), taskId (task
// run), triggerDetail (skill_sync), or individual trace (scheduled/manual).
router.get(
  "/:id/activity",
  requireAuth,
  async (req: Request, res: Response) => {
    const existing = await findOwnedByUserId({
      userId: req.user!.userId,
      deploymentId: req.params.id,
    });
    if (!existing) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const q = listAgentActivityQuery.safeParse(req.query);
    if (!q.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_QUERY });
      return;
    }
    const limit = q.data.limit ?? 50;
    const conditions = [eq(traces.deploymentId, existing.id)];
    if (q.data.cursor) {
      conditions.push(lt(traces.createdAt, new Date(q.data.cursor)));
    }

    const rows = await db
      .select()
      .from(traces)
      .where(and(...conditions))
      .orderBy(desc(traces.createdAt))
      .limit(limit * 5); // fetch more to allow grouping dedup

    // Group: prefer conversationId > taskId > skill_sync triggerDetail > trace
    const groupMap = new Map<
      string,
      {
        kind: ActivityGroup["kind"];
        label: string;
        traceCount: number;
        latestTrace: typeof rows[0];
        lastActivityAt: Date;
      }
    >();

    // Fetch task titles for any taskIds present
    const taskIds = [
      ...new Set(rows.filter((r) => r.taskId).map((r) => r.taskId!)),
    ];
    const taskTitleMap = new Map<string, string>();
    if (taskIds.length > 0) {
      const taskRows = await db
        .select({ id: tasks.id, title: tasks.title })
        .from(tasks)
        .where(inArray(tasks.id, taskIds));
      for (const t of taskRows) taskTitleMap.set(t.id, t.title);
    }

    for (const row of rows) {
      let groupKey: string;
      let kind: ActivityGroup["kind"];
      let label: string;

      if (row.conversationId) {
        groupKey = row.conversationId;
        kind = "chat";
        label = `Chat · ${row.conversationId.slice(0, 8)}`;
      } else if (row.taskId) {
        groupKey = row.taskId;
        kind = "task";
        label =
          taskTitleMap.get(row.taskId) ?? `Task ${row.taskId.slice(0, 8)}`;
      } else if (
        row.invocationSource === "skill_sync" &&
        row.triggerDetail
      ) {
        groupKey = row.triggerDetail;
        kind = "skill_sync";
        label = `Skill · ${row.triggerDetail.split("/").pop() ?? row.triggerDetail}`;
      } else {
        groupKey = row.id;
        kind = "trace";
        label = `${row.invocationSource} · ${row.id.slice(0, 8)}`;
      }

      const existingGroup = groupMap.get(groupKey);
      const rowCreatedAt = row.createdAt;
      if (!existingGroup) {
        groupMap.set(groupKey, {
          kind,
          label,
          traceCount: 1,
          latestTrace: row,
          lastActivityAt: rowCreatedAt,
        });
      } else {
        existingGroup.traceCount++;
        if (rowCreatedAt > existingGroup.lastActivityAt) {
          existingGroup.lastActivityAt = rowCreatedAt;
          existingGroup.latestTrace = row;
        }
      }
    }

    // Sort groups by lastActivityAt desc, then paginate
    const sorted = [...groupMap.entries()].sort(
      (a, b) => b[1].lastActivityAt.getTime() - a[1].lastActivityAt.getTime(),
    );
    const hasMore = sorted.length > limit;
    const page = hasMore ? sorted.slice(0, limit) : sorted;
    const nextCursor = hasMore
      ? page[page.length - 1][1].lastActivityAt.toISOString()
      : null;

    const toRef = (row: typeof rows[0]): ActivityTraceRef => ({
      id: row.id,
      status: row.status as TraceStatus,
      invocationSource: row.invocationSource as WakeSource,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      error: row.error ?? null,
      createdAt: row.createdAt.toISOString(),
    });

    const groups: ActivityGroup[] = page.map(([groupKey, g]) => ({
      groupKey,
      kind: g.kind,
      label: g.label,
      latestTrace: toRef(g.latestTrace),
      traceCount: g.traceCount,
      lastActivityAt: g.lastActivityAt.toISOString(),
    }));

    const body: ListActivityResponse = { groups, nextCursor };
    res.json(body);
  },
);

export default router;
