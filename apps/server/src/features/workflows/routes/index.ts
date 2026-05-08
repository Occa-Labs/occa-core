// /api/workflows — per-company CRUD for auto-follow-up workflow rules.
// Phase 5 storage scope; the engine (Phase 6) lives elsewhere and reads
// `parsed_definition` from the rows persisted here.

import { Router, type Request, type Response } from "express";
import { StatusCodes } from "http-status-codes";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { and, eq, isNull } from "drizzle-orm";
import { companies } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { requireAuth } from "../../../middleware/auth";
import {
  createWorkflowBody,
  updateWorkflowBody,
} from "../domain/schemas";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  updateWorkflow,
  type WorkflowServiceFailure,
} from "../services/workflows";

const router: Router = Router();

async function resolveOwnedCompany(userId: string): Promise<string | null> {
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

function failureToHttp(failure: WorkflowServiceFailure): {
  status: number;
  body: Record<string, unknown>;
} {
  switch (failure.kind) {
    case "not_found":
      return {
        status: StatusCodes.NOT_FOUND,
        body: { error: ERROR_CODES.WORKFLOW_NOT_FOUND },
      };
    case "id_conflict":
      return {
        status: StatusCodes.CONFLICT,
        body: {
          error: ERROR_CODES.WORKFLOW_ID_CONFLICT,
          yamlId: failure.yamlId,
        },
      };
    case "yaml_invalid":
      return {
        status: StatusCodes.UNPROCESSABLE_ENTITY,
        body: {
          error: ERROR_CODES.WORKFLOW_YAML_INVALID,
          detail: failure.error,
        },
      };
  }
}

router.get("/", requireAuth, async (req: Request, res: Response) => {
  const companyId = await resolveOwnedCompany(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const workflows = await listWorkflows(companyId);
  res.json({ workflows });
});

router.post("/", requireAuth, async (req: Request, res: Response) => {
  const companyId = await resolveOwnedCompany(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const parsed = createWorkflowBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_BODY,
      detail: parsed.error.flatten(),
    });
    return;
  }
  const result = await createWorkflow(companyId, parsed.data);
  if (!result.ok) {
    const { status, body } = failureToHttp(result.failure);
    res.status(status).json(body);
    return;
  }
  res.status(StatusCodes.CREATED).json({ workflow: result.value });
});

router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const companyId = await resolveOwnedCompany(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const result = await getWorkflow(req.params.id, companyId);
  if (!result.ok) {
    const { status, body } = failureToHttp(result.failure);
    res.status(status).json(body);
    return;
  }
  res.json({ workflow: result.value });
});

router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const companyId = await resolveOwnedCompany(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const parsed = updateWorkflowBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_BODY,
      detail: parsed.error.flatten(),
    });
    return;
  }
  const result = await updateWorkflow(req.params.id, companyId, parsed.data);
  if (!result.ok) {
    const { status, body } = failureToHttp(result.failure);
    res.status(status).json(body);
    return;
  }
  res.json({ workflow: result.value });
});

router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  const companyId = await resolveOwnedCompany(req.user!.userId);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NO_COMPANY });
    return;
  }
  const result = await deleteWorkflow(req.params.id, companyId);
  if (!result.ok) {
    const { status, body } = failureToHttp(result.failure);
    res.status(status).json(body);
    return;
  }
  res.status(StatusCodes.NO_CONTENT).send();
});

export default router;
