import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { LIMITS } from "../lib/limits";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../infra/database/client";
import { createTaskRecord } from "../infra/database/task-creation";
import {
  agentRuntimeProfile,
  approvals,
  companies,
  deployments,
  tasks,
} from "@occa/shared/schema";
import {
  APPROVAL_DECISIONS,
  APPROVAL_STATUSES,
  type ApprovalActionType,
  type ApprovalDTO,
  type ApprovalStatus,
  type ContentBlock,
  type DecideApprovalResponse,
  type DelegatePayload,
  type ListApprovalsResponse,
} from "@occa/shared/types";
import { requireAuth } from "../middleware/auth";
import { canDeploy } from "../features/agents/services/deployment-hierarchy";
import { createDeploymentInternal } from "../features/agents/services/deployment-create";
import { enqueueTaskDispatch } from "../infra/queue/task-worker";
import type { HirePayload } from "@occa/shared/types";
import { childLogger } from "../lib/logger";

const log = childLogger("routes:approvals");

function toApprovalDTO(row: typeof approvals.$inferSelect): ApprovalDTO {
  return {
    id: row.id,
    companyId: row.companyId,
    requestedByAgentId: row.requestedByDeploymentId,
    actionType: row.actionType as ApprovalActionType,
    payload: (row.payload as Record<string, unknown>) ?? {},
    status: row.status as ApprovalStatus,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByUserId: row.decidedByUserId ?? null,
    rejectionReason: row.rejectionReason ?? null,
  };
}

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
const listQuery = z.object({
  status: z.enum(APPROVAL_STATUSES).optional(),
});
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

// POST /api/approvals/:id/decide
const decideBody = z.object({
  decision: z.enum(APPROVAL_DECISIONS),
  rejectionReason: z.string().trim().max(LIMITS.REASON).optional(),
});
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

  const [row] = await db
    .select()
    .from(approvals)
    .where(
      and(eq(approvals.id, req.params.id), eq(approvals.companyId, companyId)),
    )
    .limit(1);
  if (!row) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.APPROVAL_NOT_FOUND });
    return;
  }
  if (row.status !== "pending") {
    res.status(StatusCodes.CONFLICT).json({ error: ERROR_CODES.APPROVAL_ALREADY_DECIDED });
    return;
  }

  const now = new Date();
  const nextStatus = decision === "approve" ? "approved" : "rejected";

  // Step 1 — flip the approval row. Single update, no tx.
  const [updated] = await db
    .update(approvals)
    .set({
      status: nextStatus,
      decidedAt: now,
      decidedByUserId: req.user!.userId,
      rejectionReason: decision === "reject" ? rejectionReason! : null,
      updatedAt: now,
    })
    .where(eq(approvals.id, row.id))
    .returning();

  // Reject path — no side effects.
  if (decision === "reject") {
    res.json({ approval: toApprovalDTO(updated) });
    return;
  }

  // Approve path — run the side effect for the action type. Side effects
  // run AFTER the row flip (not in a tx) because hire must do network
  // calls. On failure we stamp the failure into the payload so the row
  // tells the story; we still return 500 so the UI surfaces the problem.
  let final = updated;
  try {
    final = await runApprovalSideEffect(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    log.error({ err }, "side-effect failed");
    // Stamp failure on the row so UI / audits can see what happened.
    const payload = (updated.payload ?? {}) as Record<string, unknown>;
    const [stamped] = await db
      .update(approvals)
      .set({
        payload: {
          ...payload,
          failureReason: message,
          failedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(approvals.id, updated.id))
      .returning();
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: ERROR_CODES.SIDE_EFFECT_FAILED,
      detail: message,
      approval: toApprovalDTO(stamped),
    });
    return;
  }

  // After the side effect commits, kick off async dispatch for any new
  // task we created. enqueueTaskDispatch is fire-and-forget by design.
  const spawnedTaskId =
    typeof (final.payload as Record<string, unknown>)?.spawnedTaskId ===
    "string"
      ? ((final.payload as Record<string, unknown>).spawnedTaskId as string)
      : null;
  if (spawnedTaskId) {
    void enqueueTaskDispatch(spawnedTaskId).catch((err) =>
      log.error({ err, spawnedTaskId }, "post-decide enqueue task dispatch failed"),
    );
  }

  const body: DecideApprovalResponse = { approval: toApprovalDTO(final) };
  res.json(body);
});

// Side-effect dispatcher — runs after the approval row has flipped.
// Returns the (mutated) approval row so the caller can read the updated
// payload (e.g. spawnedTaskId, spawnedAgentId).
async function runApprovalSideEffect(
  approval: typeof approvals.$inferSelect,
): Promise<typeof approvals.$inferSelect> {
  switch (approval.actionType) {
    case "delegate":
      return runDelegate(approval);
    case "hire":
      return runHire(approval);
    default:
      // Unknown actionType: no-op. Approve still flips the row.
      return approval;
  }
}

async function runDelegate(
  approval: typeof approvals.$inferSelect,
): Promise<typeof approvals.$inferSelect> {
  const dp = (approval.payload ?? {}) as Partial<DelegatePayload> & {
    spawnedTaskId?: string;
    parentTaskId?: string | null;
  };
  if (
    !dp.targetAgentId ||
    typeof dp.title !== "string" ||
    typeof dp.description !== "string"
  ) {
    throw new Error("delegate_payload_invalid");
  }
  if (!approval.requestedByDeploymentId) {
    throw new Error("delegate_requester_missing");
  }

  // Re-validate scope at decide time — hierarchy could have changed.
  const check = await canDeploy(
    approval.requestedByDeploymentId,
    dp.targetAgentId,
  );
  if (!check.ok) throw new Error(`delegate_scope_invalid:${check.reason}`);

  const [target] = await db
    .select({ id: deployments.id, companyId: deployments.companyId })
    .from(deployments)
    .where(eq(deployments.id, dp.targetAgentId))
    .limit(1);
  if (!target || target.companyId !== approval.companyId) {
    throw new Error("delegate_target_missing");
  }

  const blocks: ContentBlock[] = [
    { type: "paragraph", text: dp.description as string },
  ];
  const newTask = await createTaskRecord({
    companyId: approval.companyId,
    title: dp.title as string,
    blocks,
    status: "todo",
    priority: "medium",
    taskType: "other",
    effortLevel: "m",
    tags: [],
    dueDate: null,
    assignedDeploymentId: dp.targetAgentId,
    parentTaskId: dp.parentTaskId ?? null,
    createdByUserId: null,
    createdByDeploymentId: approval.requestedByDeploymentId,
    acceptanceCriteria: dp.acceptanceCriteria ?? null,
  });

  const [stamped] = await db
    .update(approvals)
    .set({
      payload: { ...dp, spawnedTaskId: newTask.id },
      updatedAt: new Date(),
    })
    .where(eq(approvals.id, approval.id))
    .returning();
  return stamped;
}

async function runHire(
  approval: typeof approvals.$inferSelect,
): Promise<typeof approvals.$inferSelect> {
  const hp = (approval.payload ?? {}) as Partial<HirePayload> & {
    spawnedTaskId?: string;
    spawnedAgentId?: string;
    parentTaskId?: string | null;
  };
  if (
    !hp.targetRole ||
    typeof hp.targetName !== "string" ||
    typeof hp.title !== "string" ||
    typeof hp.description !== "string"
  ) {
    throw new Error("hire_payload_invalid");
  }
  if (!approval.requestedByDeploymentId) {
    throw new Error("hire_requester_missing");
  }

  // Pull requester deployment + its runtime profile to inherit
  // gateway URL + API key. The new deployment generates its own
  // keypair inside createDeploymentInternal — never share keypairs
  // across deployments.
  const [requester] = await db
    .select({
      id: deployments.id,
      companyId: deployments.companyId,
      adapterType: agentRuntimeProfile.adapterType,
      adapterConfig: agentRuntimeProfile.adapterConfig,
    })
    .from(deployments)
    .innerJoin(
      agentRuntimeProfile,
      eq(agentRuntimeProfile.deploymentId, deployments.id),
    )
    .where(eq(deployments.id, approval.requestedByDeploymentId))
    .limit(1);
  if (!requester || requester.companyId !== approval.companyId) {
    throw new Error("hire_requester_not_found");
  }
  const cfg = (requester.adapterConfig ?? {}) as Record<string, unknown>;
  if (typeof cfg.gatewayUrl !== "string" || typeof cfg.apiKey !== "string") {
    throw new Error("hire_requester_adapter_missing");
  }

  // Run the full create-pipeline. createDeploymentInternal handles
  // network calls and rolls back the OCCA rows on partial failure, so
  // by the time we read its result the system is in a coherent state
  // either way.
  const create = await createDeploymentInternal({
    companyId: approval.companyId,
    name: hp.targetName,
    role: hp.targetRole,
    adapterType: requester.adapterType,
    adapterConfig: {
      gatewayUrl: cfg.gatewayUrl as string,
      apiKey: cfg.apiKey as string,
    },
    parentDeploymentId: requester.id,
  });
  if (!create.ok) {
    throw new Error(`hire_create_failed:${create.code}:${create.message}`);
  }
  const newDeployment = create.deployment;

  // Insert the first task assigned to the new agent + stamp both the
  // spawned ids onto the approval payload. If the task insert fails
  // after the agent was created, the agent stays (no network rollback)
  // but the approval marks the failure.
  const blocks: ContentBlock[] = [
    { type: "paragraph", text: hp.description as string },
  ];
  const newTask = await createTaskRecord({
    companyId: approval.companyId,
    title: hp.title as string,
    blocks,
    status: "todo",
    priority: "medium",
    taskType: "other",
    effortLevel: "m",
    tags: [],
    dueDate: null,
    assignedDeploymentId: newDeployment.id,
    parentTaskId: hp.parentTaskId ?? null,
    createdByUserId: null,
    createdByDeploymentId: approval.requestedByDeploymentId,
    acceptanceCriteria: hp.acceptanceCriteria ?? null,
  });

  const [stamped] = await db
    .update(approvals)
    .set({
      payload: {
        ...hp,
        spawnedAgentId: newDeployment.id,
        spawnedTaskId: newTask.id,
      },
      updatedAt: new Date(),
    })
    .where(eq(approvals.id, approval.id))
    .returning();
  return stamped;
}

export default router;
