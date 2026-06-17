// Assign an existing IDLE agent (a deployment with companyId=NULL, owned by
// the user) into one of the user's companies. This is the second half of the
// "idle agent → company" model: create-flow makes the idle agent, this MOVES
// it into a company.
//
// It is a move, NOT a re-deploy: the agent is already provisioned on its
// gateway (external id + workspace seeded). We only fill in the company
// linkage (companyId, per-company index, parent, seat), re-seed the workspace
// so {{company.name}} resolves to the real company, and assign company-scoped
// skills. No second provision, no second external agent.

import { eq } from "drizzle-orm";
import {
  agentIdentities,
  agentRuntimeProfile,
  deploymentWorkspaceFiles,
  deployments,
} from "@occa/shared/schema";
import type { AgentDTO } from "@occa/shared/types";
import { CEO_ROLE, getTier } from "@occa/shared/role-catalog";
import { db } from "../../../infra/database/client";
import { getAdapter } from "../../../lib/adapter-registry";
import { childLogger } from "../../../lib/logger";
import {
  renderWorkspaceFiles,
  DEFAULT_PERSONA,
  roleLabelFor,
} from "../../../lib/workspace-templates";
import { findOwnedById } from "../../companies/repositories/companies";
import {
  autoAssignSkillsToNewAgent,
  enqueueSkillSyncs,
} from "../../skills/services/agent-skill-assign";
import { buildWorkspacePath } from "../domain/external-id";
import {
  reparentOnHeadDeploy,
  resolveAutoParentIndex,
} from "./deployment-reparent";
import { assignSeatForCompany } from "./seat-assignment";
import { hydrateDeploymentDTO } from "./deployment-status";

const log = childLogger("services:assign-to-company");

export interface AssignToCompanyInput {
  userId: string;
  deploymentId: string;
  companyId: string;
  // Optional explicit parent (a deployment id in the target company). When
  // omitted, the canonical parent is resolved from the role catalog.
  parentAgentId?: string | null;
}

export type AssignToCompanyResult =
  | { ok: true; agent: AgentDTO; reparentedCount?: number }
  | {
      ok: false;
      code:
        | "forbidden"
        | "not_found"
        | "already_assigned"
        | "parent_not_found"
        | "office_full"
        | "db_error";
      message: string;
    };

export async function assignDeploymentToCompany(
  input: AssignToCompanyInput,
): Promise<AssignToCompanyResult> {
  // 1. Authorize the target company (owner-scoped, soft-delete-aware).
  const company = await findOwnedById({
    userId: input.userId,
    companyId: input.companyId,
  });
  if (!company) {
    return { ok: false, code: "forbidden", message: "company not owned" };
  }

  // 2. Load the deployment + identity + runtime, and validate it's an idle
  //    agent owned by this user.
  const [dep] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, input.deploymentId))
    .limit(1);
  if (!dep) {
    return { ok: false, code: "not_found", message: "deployment not found" };
  }
  const [identity] = await db
    .select()
    .from(agentIdentities)
    .where(eq(agentIdentities.id, dep.agentIdentityId))
    .limit(1);
  if (!identity || identity.ownerUserId !== input.userId) {
    return { ok: false, code: "forbidden", message: "agent not owned" };
  }
  if (dep.companyId) {
    return {
      ok: false,
      code: "already_assigned",
      message: "agent is already in a company",
    };
  }
  const [runtime] = await db
    .select()
    .from(agentRuntimeProfile)
    .where(eq(agentRuntimeProfile.deploymentId, dep.id))
    .limit(1);
  if (!runtime) {
    return { ok: false, code: "not_found", message: "runtime profile missing" };
  }

  // 3. Resolve parent → deploymentIndex (explicit, or catalog auto-resolve).
  let parentDeploymentIndex: number | null = null;
  if (input.parentAgentId) {
    const [parent] = await db
      .select({
        companyId: deployments.companyId,
        deploymentIndex: deployments.deploymentIndex,
      })
      .from(deployments)
      .where(eq(deployments.id, input.parentAgentId))
      .limit(1);
    if (!parent || parent.companyId !== company.id) {
      return {
        ok: false,
        code: "parent_not_found",
        message: "parent not found in target company",
      };
    }
    parentDeploymentIndex = parent.deploymentIndex;
  } else if (dep.role !== CEO_ROLE) {
    parentDeploymentIndex = await resolveAutoParentIndex({
      companyId: company.id,
      role: dep.role,
    });
  }

  // 4. Assign a 3D office seat in the target company.
  const workstationId = await assignSeatForCompany({
    companyId: company.id,
    role: dep.role,
  });
  if (!workstationId) {
    return {
      ok: false,
      code: "office_full",
      message: "office is full — every assignable desk is taken",
    };
  }

  // 5. Move: fill in company linkage on the deployment + runtime in one tx.
  //    Per-company index computed inside the tx so it serializes against
  //    uniq_deployments_company_index.
  let movedDeployment: typeof deployments.$inferSelect;
  try {
    movedDeployment = await db.transaction(async (t) => {
      const rows = await t
        .select({ idx: deployments.deploymentIndex })
        .from(deployments)
        .where(eq(deployments.companyId, company.id));
      const idxs = rows
        .map((r) => r.idx)
        .filter((n): n is number => n !== null);
      const nextIdx = (idxs.length === 0 ? -1 : Math.max(...idxs)) + 1;

      const [d] = await t
        .update(deployments)
        .set({
          companyId: company.id,
          deploymentIndex: nextIdx,
          parentDeploymentIndex,
          updatedAt: new Date(),
        })
        .where(eq(deployments.id, dep.id))
        .returning();

      await t
        .update(agentRuntimeProfile)
        .set({
          companyId: company.id,
          workstationId,
          updatedAt: new Date(),
        })
        .where(eq(agentRuntimeProfile.deploymentId, dep.id));

      return d;
    });
  } catch (err) {
    return {
      ok: false,
      code: "db_error",
      message: err instanceof Error ? err.message : "assign update failed",
    };
  }

  // 6. Re-seed workspace so {{company.name}} resolves to the real company.
  //    Non-fatal: the company linkage is already committed; a failed re-seed
  //    only leaves the gateway copy with a stale (empty) company name.
  const externalAgentId = runtime.externalAgentId;
  const adapter = getAdapter(runtime.adapterType);
  if (externalAgentId && adapter) {
    const occaApiUrl =
      process.env.OCCA_API_URL ??
      `http://localhost:${process.env.PORT ?? "3002"}`;
    const now = new Date();
    try {
      const rendered = await renderWorkspaceFiles({
        agent: {
          name: identity.name,
          role: dep.role,
          roleLabel: roleLabelFor(dep.role),
          persona: identity.persona ?? DEFAULT_PERSONA,
        },
        company: { name: company.name },
        runtime: {
          externalAgentId,
          workspacePath: buildWorkspacePath(externalAgentId),
          createdAt: now.toISOString(),
          todayIso: now.toISOString().slice(0, 10),
          apiUrl: occaApiUrl,
        },
      });
      const seed = await adapter.seedWorkspace({
        adapterConfig: runtime.adapterConfig as Record<string, unknown>,
        externalAgentId,
        files: rendered.map((f) => ({
          filename: f.filename,
          content: f.content,
        })),
      });
      if (seed.ok) {
        const syncedAt = new Date();
        await db
          .delete(deploymentWorkspaceFiles)
          .where(eq(deploymentWorkspaceFiles.deploymentId, dep.id));
        await db.insert(deploymentWorkspaceFiles).values(
          rendered.map((f) => ({
            deploymentId: dep.id,
            companyId: company.id,
            filename: f.filename,
            content: f.content,
            source: "template" as const,
            templateOrigin: f.templateOrigin,
            syncedAt,
          })),
        );
      } else {
        log.warn(
          { deploymentId: dep.id, error: seed.error },
          "re-seed after assign failed (company linkage still committed)",
        );
      }
    } catch (err) {
      log.warn(
        { err, deploymentId: dep.id },
        "re-seed after assign threw (company linkage still committed)",
      );
    }
  }

  // 7. Auto-assign company-scoped skills (non-critical).
  try {
    const keys = await autoAssignSkillsToNewAgent(dep.id, dep.role, company.id);
    if (keys.length > 0) {
      await enqueueSkillSyncs({
        deploymentId: dep.id,
        companyId: company.id,
        skillKeys: keys,
      });
    }
  } catch (err) {
    log.error({ err, deploymentId: dep.id }, "skill assign on move failed");
  }

  // 8. Reparent hook: if the moved agent is a head, slide any specialists
  //    parented under CEO whose canonical parent is this head under it.
  let reparentedCount: number | undefined;
  if (getTier(dep.role) === "head" && movedDeployment.deploymentIndex !== null) {
    try {
      const result = await reparentOnHeadDeploy({
        companyId: company.id,
        newHeadDeploymentId: dep.id,
        newHeadRole: dep.role,
        newHeadDeploymentIndex: movedDeployment.deploymentIndex,
      });
      reparentedCount = result.movedCount;
    } catch (err) {
      log.warn({ err, deploymentId: dep.id }, "reparent on assign threw");
    }
  }

  const agent = await hydrateDeploymentDTO(movedDeployment);
  return { ok: true, agent, reparentedCount };
}
