// Canonical create-deployment pipeline. Returns a single result; usable
// from non-HTTP callers (decide-handler `hire` branch, kickoff-service).
//
// Steps (failures after step 4 trigger automatic rollback so we never
// leave a half-provisioned trio of rows):
//   1. Resolve adapter + prepare credentials (with company-shared device
//      identity if available)
//   2. Look up company (name, owner_wallet)
//   3. Assign 3D office seat
//   4. INSERT agent_identity (Truth tier — placeholder PDA pre-chain)
//      INSERT deployment      (Truth tier — per-company index)
//      INSERT agent_runtime_profile (Ephemeral tier)
//   5. provision (network)               rollback: deprovision + delete identity
//   6. UPDATE runtime profile with provision results
//   7. Render workspace templates
//   8. seedWorkspace RPC                 rollback: deprovision + delete identity
//   9. INSERT deployment_workspace_files
//  10. autoAssignSkillsToNewAgent        → desiredSkills populated
//  11. INSERT pending deployment_skill_syncs rows (worker picks up)
//
// Skill installation runs async on the worker — we don't wait. First
// task dispatch can begin while skills are still installing; the agent
// has access to OpenClaw default tools (file IO, browser, exec) in the
// meantime.
//
// On-chain placeholder note (Phase 1, mid): `agent_pubkey`, `identity_pda`,
// and `deployment_pda` are NOT NULL UNIQUE in the schema (they mirror chain
// account keys). Until on-chain `register_agent` lands, we generate
// synthetic placeholders. Recovery flow (DB drop → rebuild from chain)
// will overwrite these with real PDAs when the chain step ships.

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { normalizeGatewayUrl } from "../../../lib/gateway-url";
import { getAdapter } from "../../../lib/adapter-registry";
import {
  agentIdentities,
  agentRuntimeProfile,
  companies,
  deploymentWorkspaceFiles,
  deployments,
} from "@occa/shared/schema";
import type { AgentRole } from "@occa/shared/types";
import { CEO_ROLE } from "@occa/shared/role-catalog";
import { resolveAutoParentIndex } from "./deployment-reparent";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";
import {
  renderWorkspaceFiles,
  DEFAULT_PERSONA,
  roleLabelFor,
} from "../../../lib/workspace-templates";
import {
  autoAssignSkillsToNewAgent,
  enqueueSkillSyncs,
} from "../../skills/services/agent-skill-assign";
import { assignSeatForCompany } from "./seat-assignment";
import {
  buildExternalAgentId,
  buildWorkspacePath,
} from "../domain/external-id";

const log = childLogger("deployment-create");

export interface CreateDeploymentInternalInput {
  companyId: string;
  name: string;
  role: AgentRole;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  // Parent deployment UUID (the `id` of an existing row in the same
  // company). Resolved to `parentDeploymentIndex` at insert time.
  parentDeploymentId?: string | null;
  // Optionally reuse an existing identity (e.g. redeploying the same
  // agent into a new company). When omitted we mint a fresh identity.
  agentIdentityId?: string | null;
  // Optional flat per-task invoice rate (lamports) set at deploy time.
  // Omitted / null = no rate; operator can set it later from Wallet tab.
  taskRateLamports?: number | null;
}

export type CreateDeploymentInternalResult =
  | {
      ok: true;
      deployment: typeof deployments.$inferSelect;
      identity: typeof agentIdentities.$inferSelect;
      runtimeProfile: typeof agentRuntimeProfile.$inferSelect;
    }
  | {
      ok: false;
      code:
        | "probe_failed"
        | "validate_failed"
        | "company_not_found"
        | "parent_not_found"
        | "db_insert_failed"
        | "provision_failed"
        | "seed_failed"
        | "post_seed_persist_failed"
        | "office_full";
      message: string;
    };

export async function createDeploymentInternal(
  input: CreateDeploymentInternalInput,
): Promise<CreateDeploymentInternalResult> {
  // 1. Resolve adapter + prepare credentials.
  const adapter = getAdapter(input.adapterType);
  if (!adapter) {
    return {
      ok: false,
      code: "validate_failed",
      message: `unknown adapter type: ${input.adapterType}`,
    };
  }
  const augmentedConfig = await augmentWithCompanyDeviceIdentity({
    companyId: input.companyId,
    baseConfig: input.adapterConfig,
  });
  const creds = await adapter.prepareCredentials(augmentedConfig);
  if (!creds.ok) {
    return {
      ok: false,
      code: "validate_failed",
      message: `credentials failed: ${creds.error}${creds.reason ? ` — ${creds.reason}` : ""}`,
    };
  }
  const insertAdapterConfig: Record<string, unknown> = {
    ...augmentedConfig,
    ...creds.configPatch,
  };

  // 2. Look up company (name + owner_wallet).
  const [companyRow] = await db
    .select({ name: companies.name, ownerWallet: companies.ownerWallet })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1);
  if (!companyRow) {
    return {
      ok: false,
      code: "company_not_found",
      message: `company ${input.companyId} not found`,
    };
  }
  const companyName = companyRow.name;
  // owner_wallet is nullable until chain registration. Identity owner_wallet
  // is NOT NULL — fall back to a placeholder marker so the constraint holds.
  // The chain step will overwrite both in lockstep.
  const ownerWallet =
    companyRow.ownerWallet ?? `placeholder:${input.companyId}`;

  // 3. Resolve parent → deploymentIndex.
  //
  // Three modes:
  //   (a) Caller passed explicit `parentDeploymentId` — verify + use it.
  //   (b) Role is CEO — top of the chart, no parent.
  //   (c) No explicit parent + non-CEO — auto-resolve from the role
  //       catalog. Pick the canonical head if deployed; otherwise fall
  //       back to the company's CEO so the deployment isn't orphaned
  //       (loop incident 2026-05-13 showed that null-parent + non-CEO
  //       breaks `listSubordinates` defensive guards).
  let parentDeploymentIndex: number | null = null;
  if (input.parentDeploymentId) {
    const [parent] = await db
      .select({
        id: deployments.id,
        companyId: deployments.companyId,
        deploymentIndex: deployments.deploymentIndex,
      })
      .from(deployments)
      .where(eq(deployments.id, input.parentDeploymentId))
      .limit(1);
    if (!parent || parent.companyId !== input.companyId) {
      return {
        ok: false,
        code: "parent_not_found",
        message: `parent deployment ${input.parentDeploymentId} not found in company`,
      };
    }
    parentDeploymentIndex = parent.deploymentIndex;
  } else if (input.role !== CEO_ROLE) {
    parentDeploymentIndex = await resolveAutoParentIndex({
      companyId: input.companyId,
      role: input.role,
    });
  }

  // 4. Assign 3D office seat.
  const workstationId = await assignSeatForCompany({
    companyId: input.companyId,
    role: input.role,
  });
  if (!workstationId) {
    return {
      ok: false,
      code: "office_full",
      message: "office is full — every assignable desk is taken",
    };
  }

  // 5. Insert identity → deployment → runtime profile in a single tx.
  //    (Cascade on identity-delete cleans up the trio on rollback.)
  let identityRow: typeof agentIdentities.$inferSelect;
  let deploymentRow: typeof deployments.$inferSelect;
  let runtimeRow: typeof agentRuntimeProfile.$inferSelect;
  try {
    const result = await db.transaction(async (tx) => {
      // Reuse existing identity if caller supplied one.
      let identity: typeof agentIdentities.$inferSelect | undefined;
      if (input.agentIdentityId) {
        const [row] = await tx
          .select()
          .from(agentIdentities)
          .where(eq(agentIdentities.id, input.agentIdentityId))
          .limit(1);
        identity = row;
      }
      if (!identity) {
        const [row] = await tx
          .insert(agentIdentities)
          .values({
            ownerUserId: await resolveOwnerUserId(tx, input.companyId),
            agentPubkey: synthPlaceholderKey("ag_pk"),
            identityPda: synthPlaceholderKey("ag_pda"),
            ownerWallet,
            name: input.name,
          })
          .returning();
        identity = row;
      }

      const nextIdx = ((await maxDeploymentIndexForCompanyTx(
        tx,
        input.companyId,
      )) ?? -1) + 1;

      const [deployment] = await tx
        .insert(deployments)
        .values({
          companyId: input.companyId,
          agentIdentityId: identity.id,
          deploymentPda: synthPlaceholderKey("dep_pda"),
          deploymentIndex: nextIdx,
          role: input.role,
          parentDeploymentIndex,
          status: "active",
        })
        .returning();

      const [runtime] = await tx
        .insert(agentRuntimeProfile)
        .values({
          deploymentId: deployment.id,
          companyId: input.companyId,
          adapterType: input.adapterType,
          adapterConfig: insertAdapterConfig,
          provisioningState: "pending",
          workstationId,
          taskRateLamports: input.taskRateLamports ?? null,
        })
        .returning();

      return { identity, deployment, runtime };
    });
    identityRow = result.identity;
    deploymentRow = result.deployment;
    runtimeRow = result.runtime;
  } catch (err) {
    return {
      ok: false,
      code: "db_insert_failed",
      message: err instanceof Error ? err.message : "deployment insert failed",
    };
  }

  const externalAgentId = buildExternalAgentId(
    deploymentRow.id,
    deploymentRow.role,
    identityRow.name,
  );
  const workspacePath = buildWorkspacePath(externalAgentId);

  // Rollback helper — deletes the identity, which cascades to the
  // deployment + runtime profile + workspace files via FK.
  const rollback = async (gatewayCreated: boolean) => {
    if (gatewayCreated) {
      try {
        await adapter.deprovision({
          adapterConfig: insertAdapterConfig,
          externalAgentId,
        });
      } catch (err) {
        log.warn(
          { err, externalAgentId },
          "rollback deprovision failed",
        );
      }
    }
    try {
      // If caller passed an identity id, only delete the deployment so
      // the shared identity survives.
      if (input.agentIdentityId) {
        await db.delete(deployments).where(eq(deployments.id, deploymentRow.id));
      } else {
        await db
          .delete(agentIdentities)
          .where(eq(agentIdentities.id, identityRow.id));
      }
    } catch (err) {
      log.warn(
        { err, deploymentId: deploymentRow.id },
        "rollback delete failed",
      );
    }
  };

  // 6. Provision on the adapter side.
  const provision = await adapter.provision({
    adapterConfig: insertAdapterConfig,
    desiredExternalId: externalAgentId,
    workspacePath,
  });
  if (!provision.ok) {
    await rollback(false);
    return {
      ok: false,
      code: "provision_failed",
      message: `provision failed: ${provision.error}${
        provision.reason ? ` — ${provision.reason}` : ""
      }`,
    };
  }

  // 7. Stamp provision results onto the runtime profile.
  const [updatedRuntime] = await db
    .update(agentRuntimeProfile)
    .set({
      externalAgentId: provision.externalAgentId,
      adapterConfig: {
        ...insertAdapterConfig,
        ...provision.configPatch,
      },
      provisioningState: "ready",
      updatedAt: new Date(),
    })
    .where(eq(agentRuntimeProfile.deploymentId, deploymentRow.id))
    .returning();
  runtimeRow = updatedRuntime;

  // 8. Render workspace templates.
  const occaApiUrl =
    process.env.OCCA_API_URL ??
    `http://localhost:${process.env.PORT ?? "3002"}`;
  const now = new Date();
  let rendered: Awaited<ReturnType<typeof renderWorkspaceFiles>>;
  try {
    rendered = await renderWorkspaceFiles({
      agent: {
        name: identityRow.name,
        role: deploymentRow.role,
        roleLabel: roleLabelFor(deploymentRow.role),
        persona: identityRow.persona ?? DEFAULT_PERSONA,
      },
      company: { name: companyName },
      runtime: {
        externalAgentId: provision.externalAgentId,
        workspacePath: provision.workspacePath,
        createdAt: now.toISOString(),
        todayIso: now.toISOString().slice(0, 10),
        apiUrl: occaApiUrl,
      },
    });
  } catch (err) {
    await rollback(true);
    return {
      ok: false,
      code: "post_seed_persist_failed",
      message: err instanceof Error ? err.message : "template render failed",
    };
  }

  // 9. Push workspace files via adapter.
  const seed = await adapter.seedWorkspace({
    adapterConfig: { ...insertAdapterConfig, ...provision.configPatch },
    externalAgentId: provision.externalAgentId,
    files: rendered.map((f) => ({ filename: f.filename, content: f.content })),
  });
  if (!seed.ok) {
    await rollback(true);
    return {
      ok: false,
      code: "seed_failed",
      message: `seed failed: ${seed.error}${
        seed.reason ? ` — ${seed.reason}` : ""
      }`,
    };
  }

  // 10. Persist workspace files locally.
  const syncedAt = new Date();
  try {
    await db.insert(deploymentWorkspaceFiles).values(
      rendered.map((f) => ({
        deploymentId: deploymentRow.id,
        companyId: input.companyId,
        filename: f.filename,
        content: f.content,
        source: "template" as const,
        templateOrigin: f.templateOrigin,
        syncedAt,
      })),
    );
  } catch (err) {
    await rollback(true);
    return {
      ok: false,
      code: "post_seed_persist_failed",
      message:
        err instanceof Error ? err.message : "workspace files persist failed",
    };
  }

  // 11. Auto-assign skills (non-critical — log and continue if it fails).
  let assignedKeys: string[] = [];
  try {
    assignedKeys = await autoAssignSkillsToNewAgent(
      deploymentRow.id,
      deploymentRow.role,
      input.companyId,
    );
    if (assignedKeys.length > 0) {
      runtimeRow = { ...runtimeRow, desiredSkills: assignedKeys };
    }
  } catch (err) {
    log.error({ err }, "auto-assign skills failed (continuing)");
  }

  // 12. Enqueue skill_syncs so the worker installs immediately.
  if (assignedKeys.length > 0) {
    try {
      await enqueueSkillSyncs({
        deploymentId: deploymentRow.id,
        companyId: input.companyId,
        skillKeys: assignedKeys,
      });
    } catch (err) {
      log.error({ err }, "enqueue skill syncs failed (continuing)");
    }
  }

  return {
    ok: true,
    deployment: deploymentRow,
    identity: identityRow,
    runtimeProfile: runtimeRow,
  };
}

// ── helpers ──────────────────────────────────────────────────────────

// Per-company `MAX(deployment_index)` reused inside a tx (the repo
// helper opens its own connection — must use the tx handle here so the
// read sees uncommitted concurrent inserts and can serialize via
// `uniq_deployments_company_index`).
async function maxDeploymentIndexForCompanyTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: string,
): Promise<number | undefined> {
  const rows = await tx
    .select({ idx: deployments.deploymentIndex })
    .from(deployments)
    .where(eq(deployments.companyId, companyId));
  const idxs = rows
    .map((r) => r.idx)
    .filter((n): n is number => n !== null);
  if (idxs.length === 0) return undefined;
  return Math.max(...idxs);
}

async function resolveOwnerUserId(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: string,
): Promise<string> {
  const [row] = await tx
    .select({ ownerUserId: companies.ownerUserId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!row) throw new Error(`company ${companyId} disappeared mid-tx`);
  return row.ownerUserId;
}

// Returns a 32-byte hex placeholder string with a tag prefix so it's
// obvious in `psql` output that the value isn't a real Solana pubkey/PDA
// yet. Replaced by the real value once the chain step ships.
function synthPlaceholderKey(tag: string): string {
  return `${tag}_${randomBytes(24).toString("hex")}`;
}

// Augment a (possibly minimal — gatewayUrl + apiKey only) adapter config
// with the paired device identity already stored on a deployment in the
// same company on the same gateway URL. Pairing is per-(gatewayUrl,
// deviceId), so borrowing from a deployment on a different gateway
// wouldn't help. Match uses normalized URL (scheme/case/trailing-slash
// agnostic) because stored URLs are `wss://...` post adapter rewrite
// while caller usually passes `https://...`.
async function augmentWithCompanyDeviceIdentity(args: {
  companyId: string;
  baseConfig: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  if (args.baseConfig.deviceKeypair) return args.baseConfig;
  const gatewayUrl = args.baseConfig.gatewayUrl;
  if (typeof gatewayUrl !== "string") return args.baseConfig;

  const candidates = await db
    .select({ adapterConfig: agentRuntimeProfile.adapterConfig })
    .from(agentRuntimeProfile)
    .where(eq(agentRuntimeProfile.companyId, args.companyId));
  const targetKey = normalizeGatewayUrl(gatewayUrl);
  const existing = candidates.find((row) => {
    const cfg = row.adapterConfig as Record<string, unknown> | undefined;
    const stored = cfg?.gatewayUrl;
    return (
      typeof stored === "string" && normalizeGatewayUrl(stored) === targetKey
    );
  });
  const cfg = existing?.adapterConfig as Record<string, unknown> | undefined;
  if (!cfg?.deviceKeypair) return args.baseConfig;

  return {
    ...args.baseConfig,
    deviceKeypair: cfg.deviceKeypair,
    ...(typeof cfg.deviceToken === "string"
      ? { deviceToken: cfg.deviceToken }
      : {}),
  };
}

