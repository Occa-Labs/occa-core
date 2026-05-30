import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { and, desc, eq } from "drizzle-orm";
import { approvals, companies } from "@occa/shared/schema";
import type {
  DecideApprovalResponse,
  DismissApprovalResponse,
  ListApprovalsResponse,
} from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import { requireAuth } from "../../../middleware/auth";
import { stripSystemKeys, toApprovalDTO } from "../domain/dto";
import { decideBody, listQuery, patchBody } from "../domain/schemas";
import { decideApproval } from "../services/decide";
import { dismissApproval } from "../services/dismiss";

const router: Router = Router();

async function userCompanyId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.ownerUserId, userId), eq(companies.kind, "user")))
    .limit(1);
  return row?.id ?? null;
}

// GET /api/approvals?status=pending
router.get("/", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.json({ approvals: [] } satisfies ListApprovalsResponse);
    return;
  }
  const q = listQuery.safeParse(req.query);
  if (!q.success) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_QUERY });
    return;
  }
  const conditions = [eq(approvals.companyId, companyId)];
  if (q.data.status) conditions.push(eq(approvals.status, q.data.status));
  const rows = await db
    .select()
    .from(approvals)
    .where(and(...conditions))
    .orderBy(desc(approvals.requestedAt))
    .limit(200);
  const body: ListApprovalsResponse = { approvals: rows.map(toApprovalDTO) };
  res.json(body);
});

// PATCH /api/approvals/:id — edit a pending approval's payload before
// deciding it (HITL "edit before approve" pattern). Only the request
// fields documented per actionType are accepted; system fields stamped
// by the server (spawnedTaskId, originalPayload, etc.) are rejected.
// On first edit, server snapshots the original payload into
// `originalPayload` so audit trail survives subsequent edits.
router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
    return;
  }
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }

  const [row] = await db
    .select()
    .from(approvals)
    .where(
      and(eq(approvals.id, req.params.id), eq(approvals.companyId, companyId)),
    )
    .limit(1);
  if (!row) {
    res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.APPROVAL_NOT_FOUND });
    return;
  }
  if (row.status !== "pending") {
    res
      .status(StatusCodes.CONFLICT)
      .json({ error: ERROR_CODES.APPROVAL_ALREADY_DECIDED });
    return;
  }

  const current = (row.payload ?? {}) as Record<string, unknown>;
  const patchEntries = Object.entries(parsed.data.payload).filter(
    ([, v]) => v !== undefined,
  );
  if (patchEntries.length === 0) {
    res.json({ approval: toApprovalDTO(row) });
    return;
  }

  // Snapshot original payload on first edit. Subsequent edits keep the
  // first-edit snapshot so audit trail shows what the agent originally
  // requested, not what the previous user-edit produced.
  const alreadyEdited = "originalPayload" in current;
  const originalPayload = alreadyEdited
    ? current.originalPayload
    : stripSystemKeys(current);
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of patchEntries) {
    next[k] = v;
  }
  next.originalPayload = originalPayload;
  next.editedByUserId = req.user!.userId;
  next.editedAt = new Date().toISOString();

  const [updated] = await db
    .update(approvals)
    .set({ payload: next, updatedAt: new Date() })
    .where(eq(approvals.id, row.id))
    .returning();

  res.json({ approval: toApprovalDTO(updated) });
});

// POST /api/approvals/:id/decide
router.post("/:id/decide", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
    return;
  }
  const parsed = decideBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }
  const { decision, rejectionReason } = parsed.data;
  if (decision === "reject" && !rejectionReason?.trim()) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.REJECTION_REASON_REQUIRED });
    return;
  }

  const result = await decideApproval({
    approvalId: req.params.id,
    companyId,
    decidedByUserId: req.user!.userId,
    decision,
    reason: decision === "reject" ? rejectionReason!.trim() : null,
  });

  switch (result.kind) {
    case "not_found":
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.APPROVAL_NOT_FOUND });
      return;
    case "already_decided":
      res
        .status(StatusCodes.CONFLICT)
        .json({ error: ERROR_CODES.APPROVAL_ALREADY_DECIDED });
      return;
    case "side_effect_failed":
      // Row already flipped + failure stamped; still surface 500 so the
      // UI shows the problem.
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: ERROR_CODES.SIDE_EFFECT_FAILED,
        detail: result.message,
        approval: toApprovalDTO(result.approval),
      });
      return;
    case "ok": {
      const body: DecideApprovalResponse = {
        approval: toApprovalDTO(result.approval),
      };
      res.json(body);
      return;
    }
  }
});

// POST /api/approvals/:id/dismiss — clear a pending approval from the queue
// without an approve/reject decision (sets "cancelled"). No body, no reason.
router.post("/:id/dismiss", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
    return;
  }

  const result = await dismissApproval({
    approvalId: req.params.id,
    companyId,
    dismissedByUserId: req.user!.userId,
  });

  switch (result.kind) {
    case "not_found":
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.APPROVAL_NOT_FOUND });
      return;
    case "already_decided":
      res
        .status(StatusCodes.CONFLICT)
        .json({ error: ERROR_CODES.APPROVAL_ALREADY_DECIDED });
      return;
    case "ok": {
      const body: DismissApprovalResponse = {
        approval: toApprovalDTO(result.approval),
      };
      res.json(body);
      return;
    }
  }
});

export default router;
