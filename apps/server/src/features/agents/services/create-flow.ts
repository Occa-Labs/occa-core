// Unified agent-create pipeline. Both adapters (openclaw + hermes) go
// through this one orchestrator — adapter-specific differences are
// confined to the AgentAdapter contract calls (`prepareCredentials`,
// `provision`, `seedWorkspace`). Streams SSE step events to the caller
// the same way the route handler used to do inline.
//
// Why a separate file: the lifecycle route file is already ~1900 lines
// and POST `/` previously held two near-duplicate ~400-line branches
// (one for each adapter). Pulling the shared shape here removes the
// duplication and gives the route file room to breathe.

import type { Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import type { AgentAdapter } from "@occa/runtime-core";
import {
  agentIdentities,
  agentRuntimeProfile,
  companies,
  deploymentWorkspaceFiles,
  deployments,
  users,
} from "@occa/shared/schema";
import { CEO_ROLE, getTier } from "@occa/shared/role-catalog";
import type { CreateAgentResponse } from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import { getAdapter } from "../../../lib/adapter-registry";
import { normalizeGatewayUrl } from "../../../lib/gateway-url";
import { PG_ERROR_CODES } from "../../../lib/pg-errors";
import {
  renderWorkspaceFiles,
  DEFAULT_PERSONA,
  roleLabelFor,
} from "../../../lib/workspace-templates";
import { toCompanyDTO } from "../../companies/domain/dto";
import { findByCompanyId as findCompanyProfileByCompanyId } from "../../companies/repositories/company-profiles";
import {
  autoAssignSkillsToNewAgent,
  enqueueSkillSyncs,
} from "../../skills/services/agent-skill-assign";
import { buildExternalAgentId, buildWorkspacePath } from "../domain/external-id";
import type { createAgentBody } from "../domain/schemas";
import {
  reparentOnHeadDeploy,
  resolveAutoParentIndex,
} from "./deployment-reparent";
import { assignSeatForCompany } from "./seat-assignment";
import { hydrateDeploymentDTO } from "./deployment-status";
import { childLogger } from "../../../lib/logger";

const log = childLogger("services:create-flow");

// Synthetic placeholder for on-chain-bound columns (`agent_pubkey`,
// `identity_pda`, `deployment_pda`). NOT NULL UNIQUE in the schema; the
// chain step overwrites with real Solana pubkey/PDA values when it runs.
function synthPlaceholderKey(tag: string): string {
  return `${tag}_${randomBytes(24).toString("hex")}`;
}

// userCompanyId — local single-row read used by the create flow's
// gating (do we need to demand a `companyName` from the caller?).
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

export interface RunCreateFlowArgs {
  req: Request;
  res: Response;
  userId: string;
  parsedData: z.infer<typeof createAgentBody>;
}

export async function runCreateFlow(args: RunCreateFlowArgs): Promise<void> {
  const { req, res, userId, parsedData } = args;
  const { name, role, adapterType, parentAgentId, taskRateLamports } =
    parsedData;
  // baseConfig comes off the discriminated union — each adapter's shape
  // is validated by the zod schema upstream. From here on it's just
  // `Record<string, unknown>` so the orchestrator stays agent-agnostic.
  const baseAdapterConfig = parsedData.adapterConfig as unknown as Record<
    string,
    unknown
  >;

  // Agents are independent: creating one makes a bare IDLE agent (identity
  // + deployment with companyId=NULL + runtime), NOT tied to any company.
  // Assigning it to a company is a separate step. No company is created
  // here — the agent simply exists, available, until deployed somewhere.
  const [userRow] = await db
    .select({ wallet: users.walletAddress })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const ownerWallet = userRow?.wallet ?? `placeholder:${userId}`;

  // Switch to SSE — every error from here is streamed.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  const emit = (eventName: string, data: unknown) => {
    if (closed) return;
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const stepStart = (step: string, label: string) =>
    emit("step", { status: "running", step, label });
  const stepDone = (step: string) => emit("step", { status: "done", step });
  const fail = (
    message: string,
    step?: string,
    opts?: { agentId?: string; retryable?: boolean },
  ) => {
    emit("error", {
      message,
      step,
      agentId: opts?.agentId,
      retryable: opts?.retryable ?? false,
    });
    res.end();
  };

  const adapter: AgentAdapter | null = getAdapter(adapterType);
  if (!adapter) {
    fail(`adapter_not_registered: ${adapterType}`);
    return;
  }

  // Pre-fill baseConfig with any reusable adapter-specific state already
  // on this user (e.g. OpenClaw's paired device keypair). The lookup is
  // adapter-agnostic in shape — adapters that don't recognise these
  // fields simply ignore them when prepareCredentials runs.
  const baseConfig = await enrichBaseConfigFromUserState({
    userId,
    baseConfig: baseAdapterConfig,
  });

  // ── Step: prepareCredentials (silent — surfaces only on failure) ──
  // Contract requires "validate base creds + generate adapter-internal
  // creds". Both adapters fail-fast here on unreachable gateway / bad
  // bearer / pairing issues — no DB row gets created on failure.
  const prepared = await adapter.prepareCredentials(baseConfig);
  if (!prepared.ok) {
    fail(
      `prepare_credentials_failed: ${prepared.error}${prepared.reason ? ` — ${prepared.reason}` : ""}`,
    );
    return;
  }
  const mergedAdapterConfig: Record<string, unknown> = {
    ...baseConfig,
    ...prepared.configPatch,
  };

  // Mirror any newly-minted persistable identity to users.pendingDeviceKeypair
  // so the user's next deployment can short-circuit re-pairing. Adapters
  // with no keypair (Hermes) just produce no `deviceKeypair` in configPatch
  // and this block no-ops.
  await mirrorMintedIdentityToUser({
    userId,
    configPatch: prepared.configPatch,
  });

  // ── Step: creating_record ────────────────────────────────────────
  stepStart("creating_record", "Creating deployment record");
  let companyRow: typeof companies.$inferSelect | null = null;
  let identityRow: typeof agentIdentities.$inferSelect;
  let deploymentRow: typeof deployments.$inferSelect;
  try {
    const tx = await db.transaction(async (t) => {
      // Idle agent: no company, no seat, no per-company index, no parent.
      // All of those get assigned later when the agent joins a company.
      const [iRow] = await t
        .insert(agentIdentities)
        .values({
          ownerUserId: userId,
          agentPubkey: synthPlaceholderKey("ag_pk"),
          identityPda: synthPlaceholderKey("ag_pda"),
          ownerWallet,
          name,
          persona: parsedData.persona ?? null,
        })
        .returning();

      const [dRow] = await t
        .insert(deployments)
        .values({
          companyId: null,
          agentIdentityId: iRow.id,
          deploymentPda: synthPlaceholderKey("dep_pda"),
          deploymentIndex: null,
          role,
          status: "active",
          parentDeploymentIndex: null,
        })
        .returning();

      await t.insert(agentRuntimeProfile).values({
        deploymentId: dRow.id,
        companyId: null,
        adapterType,
        adapterConfig: mergedAdapterConfig,
        provisioningState: "pending",
        workstationId: null,
        taskRateLamports: taskRateLamports ?? null,
      });

      return {
        iRow,
        dRow,
        createdCompanyRow: null as typeof companies.$inferSelect | null,
      };
    });
    identityRow = tx.iRow;
    deploymentRow = tx.dRow;
    companyRow = tx.createdCompanyRow;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === PG_ERROR_CODES.UNIQUE_VIOLATION
    ) {
      fail("company_already_exists", "creating_record");
      return;
    }
    fail(err instanceof Error ? err.message : "db_error", "creating_record");
    return;
  }
  stepDone("creating_record");

  // ── Step: provisioning ───────────────────────────────────────────
  stepStart("provisioning", "Provisioning on gateway");
  const companyId = deploymentRow.companyId;
  const externalAgentId = buildExternalAgentId(
    deploymentRow.id,
    deploymentRow.role,
    identityRow.name,
  );
  const workspacePath = buildWorkspacePath(externalAgentId);

  let restartStepEmitted = false;
  const provision = await adapter.provision({
    adapterConfig: mergedAdapterConfig,
    desiredExternalId: externalAgentId,
    workspacePath,
    onEvent: (event) => {
      if (event.kind !== "step") return;
      if (event.status === "running" && event.step === "gateway_restart") {
        stepDone("provisioning");
        stepStart(event.step, event.label ?? "Waiting for gateway restart");
        restartStepEmitted = true;
      } else if (event.status === "done" && event.step === "gateway_restart") {
        stepDone(event.step);
        stepStart("provisioning", "Verifying provision");
      }
    },
  });
  if (!provision.ok) {
    const currentStep = restartStepEmitted ? "gateway_restart" : "provisioning";
    fail(
      `provision_failed: ${provision.error}${provision.reason ? ` — ${provision.reason}` : ""}`,
      currentStep,
      { agentId: deploymentRow.id, retryable: true },
    );
    return;
  }
  stepDone("provisioning");

  const provisionedAdapterConfig: Record<string, unknown> = {
    ...mergedAdapterConfig,
    ...provision.configPatch,
  };
  await db
    .update(agentRuntimeProfile)
    .set({
      externalAgentId: provision.externalAgentId,
      adapterConfig: provisionedAdapterConfig,
      provisioningState: "ready",
      updatedAt: new Date(),
    })
    .where(eq(agentRuntimeProfile.deploymentId, deploymentRow.id));

  // ── Step: seeding_workspace ──────────────────────────────────────
  stepStart("seeding_workspace", "Seeding workspace files");
  const occaApiUrl =
    process.env.OCCA_API_URL ??
    `http://localhost:${process.env.PORT ?? "3002"}`;
  const now = new Date();
  let rendered: Awaited<ReturnType<typeof renderWorkspaceFiles>>;
  try {
    rendered = await renderWorkspaceFiles({
      agent: {
        name: identityRow.name,
        role,
        roleLabel: roleLabelFor(role),
        persona: identityRow.persona ?? DEFAULT_PERSONA,
      },
      company: { name: companyRow ? companyRow.name : "" },
      runtime: {
        externalAgentId: provision.externalAgentId,
        workspacePath: provision.workspacePath,
        createdAt: now.toISOString(),
        todayIso: now.toISOString().slice(0, 10),
        apiUrl: occaApiUrl,
      },
    });
  } catch (err) {
    log.error({ err }, "renderWorkspaceFiles failed");
    fail(
      err instanceof Error ? err.message : "workspace_template_render_failed",
      "seeding_workspace",
      { agentId: deploymentRow.id, retryable: true },
    );
    return;
  }

  if (!companyRow && companyId) {
    const [existing] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    if (existing) {
      for (const f of rendered) {
        f.content = f.content.replace(
          /\{\{\s*company\.name\s*\}\}/g,
          existing.name,
        );
      }
    }
  }

  const seed = await adapter.seedWorkspace({
    adapterConfig: provisionedAdapterConfig,
    externalAgentId: provision.externalAgentId,
    files: rendered.map((f) => ({ filename: f.filename, content: f.content })),
  });
  if (!seed.ok) {
    fail(
      `seed_failed: ${seed.error}${seed.reason ? ` — ${seed.reason}` : ""}`,
      "seeding_workspace",
      { agentId: deploymentRow.id, retryable: true },
    );
    return;
  }

  const syncedAt = new Date();
  try {
    await db.insert(deploymentWorkspaceFiles).values(
      rendered.map((f) => ({
        deploymentId: deploymentRow.id,
        companyId,
        filename: f.filename,
        content: f.content,
        source: "template" as const,
        templateOrigin: f.templateOrigin,
        syncedAt,
      })),
    );
  } catch (err) {
    log.error({ err }, "persist workspace files failed");
    fail(
      err instanceof Error ? err.message : "workspace_files_persist_failed",
      "seeding_workspace",
      { agentId: deploymentRow.id, retryable: true },
    );
    return;
  }
  stepDone("seeding_workspace");

  // ── Step: assigning_skills (non-critical) ────────────────────────
  // Company-scoped skill auto-assign only runs once the agent is in a
  // company. Skills are role-driven; idle agents get theirs when they
  // join a company. Persona drives identity (IDENTITY.md), not skills.
  stepStart("assigning_skills", "Assigning skills");
  if (companyId) {
    try {
      const keys = await autoAssignSkillsToNewAgent(
        deploymentRow.id,
        deploymentRow.role,
        companyId,
      );
      if (keys.length > 0) {
        await enqueueSkillSyncs({
          deploymentId: deploymentRow.id,
          companyId,
          skillKeys: keys,
        });
      }
    } catch (err) {
      log.error({ err }, "auto-assign / enqueue skills failed");
    }
  }
  stepDone("assigning_skills");

  // Identity has migrated to the runtime profile adapter_config — drop
  // the pending copy so the next onboarding (e.g. second wallet) starts
  // clean instead of inheriting a stale identity. Idempotent for
  // adapters that never wrote it.
  if (prepared.configPatch.deviceKeypair) {
    await db
      .update(users)
      .set({ pendingDeviceKeypair: null })
      .where(eq(users.id, userId));
  }

  const companyProfileRow = companyRow
    ? await findCompanyProfileByCompanyId(companyRow.id)
    : null;

  // Post-deploy reparent: if this deploy created a head, slide existing
  // specialists currently parented under CEO whose canonical parent is
  // this head's role under the new head. Silent no-op otherwise.
  let reparentedCount: number | undefined;
  if (
    getTier(role) === "head" &&
    deploymentRow.companyId &&
    deploymentRow.deploymentIndex !== null
  ) {
    try {
      const result = await reparentOnHeadDeploy({
        companyId: deploymentRow.companyId,
        newHeadDeploymentId: deploymentRow.id,
        newHeadRole: role,
        newHeadDeploymentIndex: deploymentRow.deploymentIndex,
      });
      reparentedCount = result.movedCount;
    } catch (err) {
      log.warn(
        { err, deploymentId: deploymentRow.id, role },
        "reparentOnHeadDeploy threw — deploy succeeds, hierarchy may be stale",
      );
    }
  }

  const body: CreateAgentResponse = {
    agent: await hydrateDeploymentDTO(deploymentRow),
    company: companyRow ? toCompanyDTO(companyRow, companyProfileRow) : undefined,
    reparentedCount,
  };
  emit("done", body);
  res.end();
}

// ── Internal helpers ────────────────────────────────────────────────

// Pre-fill the adapter base config with any reusable state already on
// the user's side. Currently surfaces two OpenClaw-shaped fields
// (`deviceKeypair`, `deviceToken`) — adapters that don't recognise
// them just ignore them in prepareCredentials. Hermes deploys end up
// passing through unchanged.
async function enrichBaseConfigFromUserState(args: {
  userId: string;
  baseConfig: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { userId, baseConfig } = args;
  if (typeof baseConfig.gatewayUrl !== "string") return baseConfig;

  const probeKey = normalizeGatewayUrl(baseConfig.gatewayUrl);
  const userProfiles = await db
    .select({ adapterConfig: agentRuntimeProfile.adapterConfig })
    .from(agentRuntimeProfile)
    .innerJoin(companies, eq(agentRuntimeProfile.companyId, companies.id))
    .where(
      and(
        eq(companies.ownerUserId, userId),
        eq(companies.kind, "user"),
        isNull(companies.deletedAt),
      ),
    );
  const existingProfile = userProfiles.find((row) => {
    const cfg = row.adapterConfig as Record<string, unknown> | undefined;
    const stored = cfg?.gatewayUrl;
    return (
      typeof stored === "string" && normalizeGatewayUrl(stored) === probeKey
    );
  });

  const enriched: Record<string, unknown> = { ...baseConfig };
  const reusable = existingProfile?.adapterConfig as
    | Record<string, unknown>
    | undefined;
  if (reusable?.deviceKeypair) enriched.deviceKeypair = reusable.deviceKeypair;
  if (typeof reusable?.deviceToken === "string") {
    enriched.deviceToken = reusable.deviceToken;
  }
  if (!enriched.deviceKeypair) {
    const [userRow] = await db
      .select({ pendingDeviceKeypair: users.pendingDeviceKeypair })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const stored = userRow?.pendingDeviceKeypair as
      | Record<string, unknown>
      | null
      | undefined;
    if (stored?.deviceId) {
      enriched.deviceKeypair = stored;
      if (typeof stored.deviceToken === "string") {
        enriched.deviceToken = stored.deviceToken;
      }
    }
  }
  return enriched;
}

// If prepareCredentials minted a fresh persistable identity, mirror it
// to users.pendingDeviceKeypair so the next deployment can reuse it.
// Adapters with no keypair concept (Hermes) skip this entirely.
async function mirrorMintedIdentityToUser(args: {
  userId: string;
  configPatch: Record<string, unknown>;
}): Promise<void> {
  if (!args.configPatch.deviceKeypair) return;
  const tokenFromPatch =
    typeof args.configPatch.deviceToken === "string"
      ? args.configPatch.deviceToken
      : undefined;
  const storedKey = {
    ...(args.configPatch.deviceKeypair as Record<string, unknown>),
    ...(tokenFromPatch ? { deviceToken: tokenFromPatch } : {}),
  };
  await db
    .update(users)
    .set({ pendingDeviceKeypair: storedKey })
    .where(eq(users.id, args.userId));
}
