// Agent lifecycle endpoints — create + provision (SSE streamed),
// reprovision retry (SSE), list, detail, files, patch, delete.
//
// Both POST `/` and POST `/:id/reprovision` stream step events over SSE
// so the onboarding wizard / Reprovision banner can show "Provisioning…
// Waiting for gateway restart… Seeding workspace…" line by line. Heavy
// orchestration kept inline here for now; a follow-up pass can extract
// the shared provision pipeline into a service.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { and, eq, isNull } from "drizzle-orm";
import { normalizeGatewayUrl } from "../../../lib/gateway-url";
import { getAdapter } from "../../../lib/adapter-registry";
import {
  agentIdentities,
  agentRuntimeProfile,
  companies,
  deploymentWorkspaceFiles,
  deployments,
  users,
} from "@occa/shared/schema";
import type {
  CreateAgentResponse,
  ListAgentFilesResponse,
  ListAgentsResponse,
  OpenclawAdapterConfig,
  UpdateAgentFileResponse,
  WorkspaceFileDTO,
} from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import {
  findAccessibleByUserId,
  findOwnedByUserId,
  listByCompanyId as listDeploymentsByCompanyId,
  setStatus as setDeploymentStatus,
} from "../repositories/deployments";
import { findByDeploymentId as findRuntimeProfile } from "../repositories/agent-runtime-profile";
import {
  findById as findIdentityById,
  updateIdentityById,
} from "../repositories/agent-identities";
import { findByCompanyId as findCompanyProfileByCompanyId } from "../../companies/repositories/company-profiles";
import { requireAuth } from "../../../middleware/auth";
import { toCompanyDTO } from "../../companies/domain/dto";
import {
  hydrateDeploymentDTO,
  hydrateDeploymentDTOs,
} from "../services/deployment-status";
import {
  autoAssignSkillsToNewAgent,
  enqueueSkillSyncs,
} from "../../skills/services/agent-skill-assign";
import { wouldCreateCycle } from "../services/deployment-hierarchy";
import {
  renderWorkspaceFiles,
  DEFAULT_PERSONA,
  roleLabelFor,
} from "../../../lib/workspace-templates";
import { runCreateFlow } from "../services/create-flow";
import { assignSeatForCompany } from "../services/seat-assignment";
import { ALL_DESKS } from "@occa/shared/seating";
import { CEO_ROLE, getTier } from "@occa/shared/role-catalog";
import {
  reparentOnHeadDeploy,
  reparentOnHeadRetire,
  resolveAutoParentIndex,
} from "../services/deployment-reparent";
import { PG_ERROR_CODES } from "../../../lib/pg-errors";
import { reconcileInvoicesForDeployment } from "../../billing/services/reconcile-invoices";
import {
  buildExternalAgentId,
  buildWorkspacePath,
} from "../domain/external-id";
import {
  createAgentBody,
  patchAgentBody,
  reprovisionAgentBody,
  rotateBearerBody,
  switchAdapterBody,
  updateAgentFileBody,
} from "../domain/schemas";
import { switchAdapter } from "../services/switch-adapter";
import {
  findByName as findWorkspaceFile,
  updateContent as updateWorkspaceFileContent,
} from "../repositories/deployment-workspace-files";
import { WORKSPACE_FILENAMES } from "../../../lib/workspace-templates";
import { log } from "./_shared";

const router: Router = Router();

// Local helper — single-row read used by GET / agent list when no
// agent has been deployed yet (legitimate empty case). Deployment-level
// lookups go through `findAccessibleByUserId` (owner OR the company the
// agent is deployed to); identity-level actions use `findOwnedByUserId`.
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

// POST /api/agents — streams progress via SSE then emits "done" with the
// created agent. Events: step {status:"running"|"done", step, label?} |
// done {agent, company?} | error {message, step?}
//
// Body is a discriminated union by `adapterType`. Both branches go
// through the unified `runCreateFlow` orchestrator — adapter-specific
// differences (device pairing, gateway-restart, etc.) are handled
// inside the AgentAdapter contract.
router.post("/", requireAuth, async (req: Request, res: Response) => {
  const parsed = createAgentBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({
        error: ERROR_CODES.INVALID_BODY,
        detail: parsed.error.flatten(),
      });
    return;
  }
  await runCreateFlow({
    req,
    res,
    userId: req.user!.userId,
    parsedData: parsed.data,
  });
});

// POST /api/agents/:id/reprovision — retry provisioning + seeding from
// the failed step without touching the DB record. Streams SSE identical
// to POST /. Backfills missing adapter creds from the company's CEO so
// failed kickoff hires (which never persisted their own keypair) can be
// retried without a 400.
router.post(
  "/:id/reprovision",
  requireAuth,
  async (req: Request, res: Response) => {
    // Body is optional — only set on chain-recovery re-pair, where the
    // caller supplies fresh `{gatewayUrl, apiKey}` for a runtime profile
    // that came back from chain rebuild with empty Tier 3.
    const parsedBody = reprovisionAgentBody.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({
          error: ERROR_CODES.INVALID_BODY,
          detail: parsedBody.error.flatten(),
        });
      return;
    }
    // Reprovision in Phase 0 only supports the openclaw adapter (the
    // device-keypair + gateway-restart pipeline that follows is openclaw-
    // specific). Hermes agents fall through to a 501 below once we've
    // loaded the runtime profile and can read the adapter type.
    // TODO(adapter-multi): land hermes reprovision when the openclaw
    // path is refactored behind `getAdapter()`.
    const overrideConfig = parsedBody.data.adapterConfig as
      | OpenclawAdapterConfig
      | undefined;

    const deploymentRecord = await findAccessibleByUserId({
      userId: req.user!.userId,
      deploymentId: req.params.id,
    });
    if (!deploymentRecord) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const identityRecord = await findIdentityById(
      deploymentRecord.agentIdentityId,
    );
    if (!identityRecord) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const profile = await findRuntimeProfile(deploymentRecord.id);
    if (!profile) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.AGENT_NOT_CONFIGURED });
      return;
    }
    if (profile.adapterType !== "openclaw") {
      // Reprovision is openclaw-specific: it covers the
      // device-rekey-and-restart-the-gateway pipeline that Hermes
      // doesn't have. For Hermes, the bearer-rotation endpoint
      // (/:id/adapter/rotate-bearer) covers the equivalent
      // operational case. UI guides the user there instead.
      res
        .status(StatusCodes.NOT_IMPLEMENTED)
        .json({ error: "reprovision_not_supported_for_adapter" });
      return;
    }

    const adapter = getAdapter(profile.adapterType);
    if (!adapter) {
      res
        .status(StatusCodes.INTERNAL_SERVER_ERROR)
        .json({ error: ERROR_CODES.INTERNAL_ERROR });
      return;
    }

    let cfg = (profile.adapterConfig ?? {}) as Record<string, unknown>;

    // Recovery re-pair: caller supplied fresh creds. Hand them straight
    // to `prepareCredentials` with NO `deviceKeypair` in the baseConfig
    // — that signals the adapter to mint a new one and validate it
    // against the supplied gateway. Skip the CEO-fallback branch
    // entirely — this path is explicit and self-sufficient.
    if (overrideConfig) {
      const prepared = await adapter.prepareCredentials({
        gatewayUrl: overrideConfig.gatewayUrl,
        apiKey: overrideConfig.apiKey,
      });
      if (!prepared.ok) {
        res
          .status(StatusCodes.BAD_GATEWAY)
          .json({
            error: ERROR_CODES.GATEWAY_UNREACHABLE,
            reason: prepared.error,
          });
        return;
      }
      const merged: Record<string, unknown> = {
        ...cfg,
        gatewayUrl: overrideConfig.gatewayUrl,
        apiKey: overrideConfig.apiKey,
        ...prepared.configPatch,
      };
      cfg = merged;
      await db
        .update(agentRuntimeProfile)
        .set({ adapterConfig: merged, updatedAt: new Date() })
        .where(eq(agentRuntimeProfile.deploymentId, deploymentRecord.id));
      log.info(
        { deploymentId: deploymentRecord.id },
        "reprovision: re-paired gateway with fresh keypair",
      );
    }

    // Backfill missing gateway creds / keypair from the company's CEO.
    // Old kickoff-service inserts didn't persist the deviceKeypair on
    // hires until provisioning succeeded — so a hire that failed
    // mid-flight has gatewayUrl + apiKey but no keypair, and reprovision
    // would 400 with `agent_not_configured`. The fix is to share the
    // CEO's keypair (every hire reuses it by design — same paired
    // device, different agent ids). Persist the backfilled config back
    // to the row so subsequent calls don't repeat the lookup.
    const missing =
      typeof cfg.gatewayUrl !== "string" ||
      typeof cfg.apiKey !== "string" ||
      !cfg.deviceKeypair;
    if (missing) {
      // Find the CEO deployment in the same company, then read the
      // adapter config off its runtime profile.
      const [ceoCfgRow] = await db
        .select({ adapterConfig: agentRuntimeProfile.adapterConfig })
        .from(agentRuntimeProfile)
        .innerJoin(
          deployments,
          eq(agentRuntimeProfile.deploymentId, deployments.id),
        )
        .where(
          and(
            eq(deployments.companyId, deploymentRecord.companyId!),
            eq(deployments.role, CEO_ROLE),
          ),
        )
        .limit(1);
      const ceoCfg = (ceoCfgRow?.adapterConfig ?? {}) as Record<
        string,
        unknown
      >;
      if (
        typeof ceoCfg.gatewayUrl !== "string" ||
        typeof ceoCfg.apiKey !== "string" ||
        !ceoCfg.deviceKeypair
      ) {
        // CEO is also unconfigured — nothing to fall back to. Surface
        // the original error code so the UI message stays meaningful.
        res
          .status(StatusCodes.BAD_REQUEST)
          .json({ error: ERROR_CODES.AGENT_NOT_CONFIGURED });
        return;
      }
      // Preserve per-deployment extras the row already had (e.g.
      // openclawAgentId, workspacePath from a prior partial provision),
      // then overlay CEO credentials. Order matters: per-deployment
      // fields first, credentials last so the broken baseline gets
      // repaired.
      const merged: Record<string, unknown> = {
        ...cfg,
        gatewayUrl: ceoCfg.gatewayUrl,
        apiKey: ceoCfg.apiKey,
        deviceKeypair: ceoCfg.deviceKeypair,
      };
      if (typeof ceoCfg.deviceToken === "string") {
        merged.deviceToken = ceoCfg.deviceToken;
      }
      cfg = merged;
      await db
        .update(agentRuntimeProfile)
        .set({ adapterConfig: merged, updatedAt: new Date() })
        .where(eq(agentRuntimeProfile.deploymentId, deploymentRecord.id));
      log.info(
        { deploymentId: deploymentRecord.id, role: deploymentRecord.role },
        "reprovision: backfilled adapter creds from CEO keypair",
      );
    }

    const externalAgentId =
      profile.externalAgentId ??
      buildExternalAgentId(
        deploymentRecord.id,
        deploymentRecord.role,
        identityRecord.name,
      );
    const workspacePath = buildWorkspacePath(externalAgentId);

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
    const fail = (message: string, step?: string) => {
      emit("error", {
        message,
        step,
        agentId: deploymentRecord.id,
        retryable: true,
      });
      res.end();
    };

    // Step: provisioning
    stepStart("provisioning", "Provisioning on gateway");
    let restartStepEmitted = false;
    const provision = await adapter.provision({
      adapterConfig: cfg,
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
      const currentStep = restartStepEmitted
        ? "gateway_restart"
        : "provisioning";
      fail(
        `provision_failed: ${provision.error}${provision.reason ? ` — ${provision.reason}` : ""}`,
        currentStep,
      );
      return;
    }
    stepDone("provisioning");

    const provisionedAdapterConfig: Record<string, unknown> = {
      ...cfg,
      ...provision.configPatch,
    };
    await db
      .update(agentRuntimeProfile)
      .set({
        externalAgentId: provision.externalAgentId,
        adapterConfig: provisionedAdapterConfig,
        updatedAt: new Date(),
      })
      .where(eq(agentRuntimeProfile.deploymentId, deploymentRecord.id));

    // Step: seed workspace files (upsert — overwrite any partial
    // previous seed)
    stepStart("seeding_workspace", "Seeding workspace files");
    const occaApiUrl =
      process.env.OCCA_API_URL ??
      `http://localhost:${process.env.PORT ?? "3002"}`;
    const now = new Date();

    const [companyRow] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, deploymentRecord.companyId!))
      .limit(1);

    let rendered: Awaited<ReturnType<typeof renderWorkspaceFiles>>;
    try {
      rendered = await renderWorkspaceFiles({
        agent: {
          name: identityRecord.name,
          role: deploymentRecord.role,
          roleLabel: roleLabelFor(deploymentRecord.role),
          persona: identityRecord.persona ?? DEFAULT_PERSONA,
        },
        company: { name: companyRow?.name ?? "" },
        runtime: {
          externalAgentId: provision.externalAgentId,
          workspacePath: provision.workspacePath,
          createdAt: now.toISOString(),
          todayIso: now.toISOString().slice(0, 10),
          apiUrl: occaApiUrl,
        },
      });
    } catch (err) {
      log.error({ err }, "reprovision: renderWorkspaceFiles failed");
      fail(
        err instanceof Error ? err.message : "workspace_template_render_failed",
        "seeding_workspace",
      );
      return;
    }

    const seed = await adapter.seedWorkspace({
      adapterConfig: provisionedAdapterConfig,
      externalAgentId: provision.externalAgentId,
      files: rendered.map((f) => ({
        filename: f.filename,
        content: f.content,
      })),
    });
    if (!seed.ok) {
      fail(
        `seed_failed: ${seed.error}${seed.reason ? ` — ${seed.reason}` : ""}`,
        "seeding_workspace",
      );
      return;
    }

    // Upsert workspace files — replace any existing rows for this deployment
    try {
      await db
        .delete(deploymentWorkspaceFiles)
        .where(eq(deploymentWorkspaceFiles.deploymentId, deploymentRecord.id));
      await db.insert(deploymentWorkspaceFiles).values(
        rendered.map((f) => ({
          deploymentId: deploymentRecord.id,
          companyId: deploymentRecord.companyId,
          filename: f.filename,
          content: f.content,
          source: "template" as const,
          templateOrigin: f.templateOrigin,
          syncedAt: now,
        })),
      );
    } catch (err) {
      log.error({ err }, "reprovision: persist workspace files failed");
      fail(
        err instanceof Error ? err.message : "workspace_files_persist_failed",
        "seeding_workspace",
      );
      return;
    }
    stepDone("seeding_workspace");

    // Step: assign skills + enqueue installs (non-critical)
    stepStart("assigning_skills", "Assigning skills");
    try {
      if (deploymentRecord.companyId) {
        const keys = await autoAssignSkillsToNewAgent(
          deploymentRecord.id,
          deploymentRecord.role,
          deploymentRecord.companyId,
        );
        if (keys.length > 0) {
          await enqueueSkillSyncs({
            deploymentId: deploymentRecord.id,
            companyId: deploymentRecord.companyId,
            skillKeys: keys,
          });
        }
      }
    } catch (err) {
      log.error({ err }, "reprovision: auto-assign / enqueue skills failed");
    }
    stepDone("assigning_skills");

    // Mark the runtime profile healthy now that gateway provision +
    // workspace seed + skill assignment all completed. Without this, the
    // deployment stays in its pre-retry state (e.g. `failed`) and the
    // Overview tab keeps showing the "Provisioning incomplete" banner
    // even after a successful retry.
    await db
      .update(agentRuntimeProfile)
      .set({
        provisioningState: "ready",
        provisioningError: null,
        updatedAt: new Date(),
      })
      .where(eq(agentRuntimeProfile.deploymentId, deploymentRecord.id));

    const companyProfileRow = companyRow
      ? await findCompanyProfileByCompanyId(companyRow.id)
      : null;
    const body: CreateAgentResponse = {
      agent: await hydrateDeploymentDTO(deploymentRecord),
      company: companyRow
        ? toCompanyDTO(companyRow, companyProfileRow)
        : undefined,
    };
    emit("done", body);
    res.end();
  },
);

// GET /api/agents — list this company's deployments.
router.get("/", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    const body: ListAgentsResponse = { agents: [] };
    res.json(body);
    return;
  }
  const rows = await listDeploymentsByCompanyId(companyId);
  const body: ListAgentsResponse = { agents: await hydrateDeploymentDTOs(rows) };
  res.json(body);
});

// GET /api/agents/:id — detail.
router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const existing = await findAccessibleByUserId({
    userId: req.user!.userId,
    deploymentId: req.params.id,
  });
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  res.json({ agent: await hydrateDeploymentDTO(existing) });
});

// POST /api/agents/:id/availability — owner toggles whether this agent is
// listed in the cross-owner marketplace. Turning it ON requires the agent
// to be anchored on-chain (real identity, not a placeholder), so only
// invitable + payable agents surface to other companies.
router.post(
  "/:id/availability",
  requireAuth,
  async (req: Request, res: Response) => {
    const available = (req.body as { available?: unknown } | undefined)
      ?.available;
    if (typeof available !== "boolean") {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    // Identity-level: marketplace availability is the agent OWNER's call,
    // not the hiring company's. Stays owner-scoped.
    const existing = await findOwnedByUserId({
      userId: req.user!.userId,
      deploymentId: req.params.id,
    });
    if (!existing) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    if (available) {
      const identity = await findIdentityById(existing.agentIdentityId);
      if (!identity?.chainTxSignature) {
        res
          .status(StatusCodes.CONFLICT)
          .json({ error: ERROR_CODES.CHAIN_NOT_ANCHORED });
        return;
      }
      if (!identity.receivingAddress) {
        res
          .status(StatusCodes.CONFLICT)
          .json({ error: ERROR_CODES.RECEIVING_WALLET_UNSET });
        return;
      }
    }
    await updateIdentityById({
      identityId: existing.agentIdentityId,
      patch: { availableForWork: available },
    });
    res.json({ agent: await hydrateDeploymentDTO(existing) });
  },
);

// GET /api/agents/:id/files — list workspace files from
// deployment_workspace_files.
router.get("/:id/files", requireAuth, async (req: Request, res: Response) => {
  const existing = await findAccessibleByUserId({
    userId: req.user!.userId,
    deploymentId: req.params.id,
  });
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  const rows = await db
    .select()
    .from(deploymentWorkspaceFiles)
    .where(eq(deploymentWorkspaceFiles.deploymentId, existing.id));
  const body: ListAgentFilesResponse = {
    files: rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      content: r.content,
      source: r.source,
      templateOrigin: r.templateOrigin ?? null,
      syncedAt: r.syncedAt?.toISOString() ?? null,
      updatedAt: r.updatedAt.toISOString(),
    })),
  };
  res.json(body);
});

// PATCH /api/agents/:id/files/:filename — edit one workspace file.
// Writes to deployment_workspace_files with source='user_edit', then
// best-effort pushes the single file to the gateway via seedWorkspace.
// On gateway failure the DB write still lands (syncedAt=null) and the
// response includes a syncWarning the client can surface or retry on.
router.patch(
  "/:id/files/:filename",
  requireAuth,
  async (req: Request, res: Response) => {
    const existing = await findAccessibleByUserId({
      userId: req.user!.userId,
      deploymentId: req.params.id,
    });
    if (!existing) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }

    const filename = req.params.filename;
    if (!(WORKSPACE_FILENAMES as readonly string[]).includes(filename)) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.FILE_NOT_IN_INVENTORY });
      return;
    }

    const parsed = updateAgentFileBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.INVALID_BODY,
        detail: parsed.error.flatten(),
      });
      return;
    }

    const fileRow = await findWorkspaceFile({
      deploymentId: existing.id,
      filename,
    });
    if (!fileRow) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.FILE_NOT_IN_INVENTORY });
      return;
    }

    // Best-effort push the single file to the agent runtime. Unprovisioned
    // agent or missing adapter skips the push and returns the DB write
    // with a sync warning.
    const profile = await findRuntimeProfile(existing.id);
    const cfg = (profile?.adapterConfig as Record<string, unknown>) ?? {};
    const externalAgentId = profile?.externalAgentId ?? null;
    const fileAdapter = profile?.adapterType
      ? getAdapter(profile.adapterType)
      : null;

    let pushResult: Awaited<
      ReturnType<NonNullable<typeof fileAdapter>["seedWorkspace"]>
    > | null = null;
    if (fileAdapter && externalAgentId) {
      try {
        pushResult = await fileAdapter.seedWorkspace({
          adapterConfig: cfg,
          externalAgentId,
          files: [{ filename, content: parsed.data.content }],
        });
      } catch (err) {
        log.warn(
          { err, deploymentId: existing.id, filename },
          "workspace file edit: adapter push threw",
        );
      }
    }

    const syncedAt = pushResult?.ok ? new Date() : null;
    const updated = await updateWorkspaceFileContent({
      deploymentId: existing.id,
      filename,
      content: parsed.data.content,
      source: "user_edit",
      syncedAt,
    });

    if (!updated) {
      res
        .status(StatusCodes.INTERNAL_SERVER_ERROR)
        .json({ error: ERROR_CODES.INTERNAL_ERROR });
      return;
    }

    const fileDTO: WorkspaceFileDTO = {
      id: updated.id,
      filename: updated.filename,
      content: updated.content,
      source: updated.source,
      templateOrigin: updated.templateOrigin ?? null,
      syncedAt: updated.syncedAt?.toISOString() ?? null,
      updatedAt: updated.updatedAt.toISOString(),
    };

    const body: UpdateAgentFileResponse = { file: fileDTO };
    if (!pushResult?.ok) {
      body.syncWarning = {
        code: pushResult?.error ?? "gateway_sync_skipped",
        detail: pushResult?.reason,
      };
    }
    res.json(body);
  },
);

// PATCH /api/agents/:id — edit name/role/adapterConfig.
// Writes fan out to three tables: identity (name), deployment (role,
// parentDeploymentIndex), runtime profile (adapterConfig, workstationId,
// modelOverride).
router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const existing = await findAccessibleByUserId({
    userId: req.user!.userId,
    deploymentId: req.params.id,
  });
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  const parsed = patchAgentBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({
        error: ERROR_CODES.INVALID_BODY,
        detail: parsed.error.flatten(),
      });
    return;
  }

  const identityPatch: Partial<typeof agentIdentities.$inferInsert> = {};
  const deploymentPatch: Partial<typeof deployments.$inferInsert> = {};
  const profilePatch: Partial<typeof agentRuntimeProfile.$inferInsert> = {};

  // `name` is identity-level (portable, shared across every company the
  // agent is in), so only the agent OWNER may change it. A hiring company
  // can edit deployment-level fields below but not rename someone's agent.
  if (parsed.data.name !== undefined) {
    const identity = await findIdentityById(existing.agentIdentityId);
    if (identity?.ownerUserId !== req.user!.userId) {
      res.status(StatusCodes.FORBIDDEN).json({ error: ERROR_CODES.FORBIDDEN });
      return;
    }
    identityPatch.name = parsed.data.name;
  }
  if (parsed.data.role !== undefined) deploymentPatch.role = parsed.data.role;

  if (parsed.data.adapterConfig !== undefined) {
    const profile = await findRuntimeProfile(existing.id);
    const existingConfig =
      (profile?.adapterConfig as Record<string, unknown>) ?? {};
    // Spread the whole incoming config so this works for any adapter
    // shape — both openclaw and hermes use `{ gatewayUrl, apiKey }`.
    // Per-adapter validation of the shape against the agent's actual
    // adapterType lives in the zod schema.
    profilePatch.adapterConfig = {
      ...existingConfig,
      ...parsed.data.adapterConfig,
    };
  }

  // Wire field stays `parentAgentId` (UUID) for web compat. Resolve to
  // per-company `parentDeploymentIndex` here.
  if (parsed.data.parentAgentId !== undefined) {
    const next = parsed.data.parentAgentId;
    if (next === null) {
      deploymentPatch.parentDeploymentIndex = null;
    } else {
      const [parentRow] = await db
        .select({
          id: deployments.id,
          companyId: deployments.companyId,
          deploymentIndex: deployments.deploymentIndex,
        })
        .from(deployments)
        .where(eq(deployments.id, next))
        .limit(1);
      if (!parentRow || parentRow.companyId !== existing.companyId) {
        res
          .status(StatusCodes.BAD_REQUEST)
          .json({ error: ERROR_CODES.PARENT_NOT_IN_COMPANY });
        return;
      }
      const cycle = await wouldCreateCycle(existing.id, next);
      if (cycle) {
        res
          .status(StatusCodes.BAD_REQUEST)
          .json({ error: ERROR_CODES.WOULD_CREATE_CYCLE });
        return;
      }
      deploymentPatch.parentDeploymentIndex = parentRow.deploymentIndex;
    }
  }

  if (parsed.data.workstationId !== undefined) {
    const next = parsed.data.workstationId;
    if (!ALL_DESKS.has(next)) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.WORKSTATION_NOT_FOUND });
      return;
    }
    profilePatch.workstationId = next;
  }
  if (parsed.data.modelOverride !== undefined) {
    profilePatch.modelOverride = parsed.data.modelOverride;
  }
  if (parsed.data.taskRateLamports !== undefined) {
    profilePatch.taskRateLamports = parsed.data.taskRateLamports;
  }

  const noop =
    Object.keys(identityPatch).length === 0 &&
    Object.keys(deploymentPatch).length === 0 &&
    Object.keys(profilePatch).length === 0;
  if (noop) {
    res.json({ agent: await hydrateDeploymentDTO(existing) });
    return;
  }

  let row: typeof deployments.$inferSelect = existing;
  try {
    await db.transaction(async (tx) => {
      if (Object.keys(identityPatch).length > 0) {
        await tx
          .update(agentIdentities)
          .set({ ...identityPatch, updatedAt: new Date() })
          .where(eq(agentIdentities.id, existing.agentIdentityId));
      }
      if (Object.keys(deploymentPatch).length > 0) {
        const [updated] = await tx
          .update(deployments)
          .set({ ...deploymentPatch, updatedAt: new Date() })
          .where(eq(deployments.id, existing.id))
          .returning();
        row = updated;
      }
      if (Object.keys(profilePatch).length > 0) {
        await tx
          .update(agentRuntimeProfile)
          .set({ ...profilePatch, updatedAt: new Date() })
          .where(eq(agentRuntimeProfile.deploymentId, existing.id));
      }
    });
  } catch (err) {
    // Partial unique index `(company_id, workstation_id)` on the runtime
    // profile blocks moving onto a desk another deployment already owns
    // — surface as a typed error so the frontend can show "desk taken"
    // instead of a generic 500.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === PG_ERROR_CODES.UNIQUE_VIOLATION
    ) {
      res
        .status(StatusCodes.CONFLICT)
        .json({ error: ERROR_CODES.WORKSTATION_OCCUPIED });
      return;
    }
    throw err;
  }

  res.json({ agent: await hydrateDeploymentDTO(row) });

  // Phase 1b-ii: setting a task rate back-fills invoices for any `done`
  // tasks this agent finished before the rate existed. Fire-and-forget —
  // the response already went out; reconcile self-heals the invoice set.
  if (
    parsed.data.taskRateLamports !== undefined &&
    parsed.data.taskRateLamports !== null &&
    parsed.data.taskRateLamports > 0
  ) {
    void reconcileInvoicesForDeployment(existing.id).catch((err) => {
      req.log.error(
        { err, agentId: existing.id },
        "reconcileInvoicesForDeployment failed after rate set (non-fatal)",
      );
    });
  }
});

// POST /api/agents/:id/pause — flip deployment status to "paused".
// Reversible alternative to retire — keeps row + identity intact, just
// removes the agent from active-team filters (load-context excludes
// non-active). CEO chat-mode sees "active team empty" if the only
// teammate is paused → falls back to CREATE_TASK / self-execute.
// CEO deployment cannot be paused — every other agent borrows CEO's
// device keypair, and chat surfaces the CEO as the sole contact.
router.post("/:id/pause", requireAuth, async (req: Request, res: Response) => {
  const existing = await findAccessibleByUserId({
    userId: req.user!.userId,
    deploymentId: req.params.id,
  });
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  if (existing.role === CEO_ROLE) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: "cannot_pause_ceo" });
    return;
  }
  await setDeploymentStatus({
    deploymentId: existing.id,
    status: "paused",
  });
  const refreshed = await findAccessibleByUserId({
    userId: req.user!.userId,
    deploymentId: req.params.id,
  });
  res.json({ agent: await hydrateDeploymentDTO(refreshed!) });
});

// POST /api/agents/:id/activate — reverse of /pause. Sets status back
// to "active". Idempotent (calling on an already-active agent is a no-op).
// POST /api/agents/:id/adapter/rotate-bearer — Hermes-only.
// Replaces the runtime bearer in adapter_config after a successful
// probe against the existing gatewayUrl. Lets the user rotate the API
// key for a deployed Hermes agent without re-doing the deploy flow.
//
// OpenClaw's bearer is bound to the paired device identity — rotating
// it has different lifecycle implications (re-pairing, gateway side
// state) and goes through `/:id/reprovision` instead. Returns 501 for
// non-hermes adapters.
router.post(
  "/:id/adapter/rotate-bearer",
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = rotateBearerBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.INVALID_BODY,
        detail: parsed.error.flatten(),
      });
      return;
    }
    const existing = await findAccessibleByUserId({
      userId: req.user!.userId,
      deploymentId: req.params.id,
    });
    if (!existing) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const profile = await findRuntimeProfile(existing.id);
    if (!profile) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.AGENT_NOT_CONFIGURED });
      return;
    }
    if (profile.adapterType !== "hermes") {
      res
        .status(StatusCodes.NOT_IMPLEMENTED)
        .json({ error: "rotate_bearer_not_supported_for_adapter" });
      return;
    }
    const cfg = (profile.adapterConfig ?? {}) as Record<string, unknown>;
    if (typeof cfg.gatewayUrl !== "string") {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.AGENT_NOT_CONFIGURED });
      return;
    }

    const adapter = getAdapter("hermes");
    if (!adapter) {
      res
        .status(StatusCodes.INTERNAL_SERVER_ERROR)
        .json({ error: ERROR_CODES.INTERNAL_ERROR });
      return;
    }

    // Probe with the new key BEFORE touching the row — refuse to
    // overwrite a working bearer with one that can't authenticate.
    const probe = await adapter.probeConnection({
      gatewayUrl: cfg.gatewayUrl,
      apiKey: parsed.data.apiKey,
    });
    if (!probe.ok) {
      res.status(StatusCodes.BAD_GATEWAY).json({
        error: ERROR_CODES.GATEWAY_UNREACHABLE,
        reason: probe.error,
      });
      return;
    }

    await db
      .update(agentRuntimeProfile)
      .set({
        adapterConfig: { ...cfg, apiKey: parsed.data.apiKey },
        updatedAt: new Date(),
      })
      .where(eq(agentRuntimeProfile.deploymentId, existing.id));

    res.json({ ok: true, latencyMs: probe.latencyMs });
  },
);

// POST /api/agents/:id/adapter/switch — move an already-deployed agent to
// a different runtime (openclaw ↔ hermes). Identity, deployment,
// hierarchy, seat, and task history stay; only the runtime profile is
// re-pointed. Company-or-owner accessible (a company operator can move
// the agents deployed to their company). Body is discriminated on the
// TARGET adapterType. Returns the re-hydrated agent on success.
router.post(
  "/:id/adapter/switch",
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = switchAdapterBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.INVALID_BODY,
        detail: parsed.error.flatten(),
      });
      return;
    }

    const deployment = await findAccessibleByUserId({
      userId: req.user!.userId,
      deploymentId: req.params.id,
    });
    if (!deployment) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const identity = await findIdentityById(deployment.agentIdentityId);
    if (!identity) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const profile = await findRuntimeProfile(deployment.id);
    if (!profile || !profile.companyId) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.AGENT_NOT_CONFIGURED });
      return;
    }

    const result = await switchAdapter({
      deploymentId: deployment.id,
      companyId: profile.companyId,
      role: deployment.role,
      name: identity.name,
      persona: identity.persona ?? null,
      desiredSkills: profile.desiredSkills ?? [],
      oldAdapterType: profile.adapterType,
      oldAdapterConfig: (profile.adapterConfig ?? {}) as Record<
        string,
        unknown
      >,
      oldExternalAgentId: profile.externalAgentId ?? null,
      targetAdapterType: parsed.data.adapterType,
      targetAdapterConfig: parsed.data.adapterConfig,
    });

    if (!result.ok) {
      const status =
        result.code === "probe_failed"
          ? StatusCodes.BAD_GATEWAY
          : result.code === "validate_failed"
            ? StatusCodes.BAD_REQUEST
            : StatusCodes.BAD_GATEWAY;
      res.status(status).json({
        error:
          result.code === "probe_failed"
            ? ERROR_CODES.GATEWAY_UNREACHABLE
            : ERROR_CODES.INVALID_BODY,
        code: result.code,
        reason: result.message,
      });
      return;
    }

    const refreshed = await findAccessibleByUserId({
      userId: req.user!.userId,
      deploymentId: req.params.id,
    });
    res.json({ agent: await hydrateDeploymentDTO(refreshed!) });
  },
);

router.post("/:id/activate", requireAuth, async (req: Request, res: Response) => {
  const existing = await findAccessibleByUserId({
    userId: req.user!.userId,
    deploymentId: req.params.id,
  });
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  await setDeploymentStatus({
    deploymentId: existing.id,
    status: "active",
  });
  const refreshed = await findAccessibleByUserId({
    userId: req.user!.userId,
    deploymentId: req.params.id,
  });
  res.json({ agent: await hydrateDeploymentDTO(refreshed!) });
});

// DELETE /api/agents/:id — remove from gateway, then DB. Cascade from
// `deployments` clears runtime profile, workspace files, tokens, runtime
// state, sessions, traces. The shared `agent_identity` survives by
// design (an identity may be deployed to multiple companies owned by
// the same wallet).
router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  const existing = await findAccessibleByUserId({
    userId: req.user!.userId,
    deploymentId: req.params.id,
  });
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }

  const profile = await findRuntimeProfile(existing.id);
  const config = (profile?.adapterConfig ?? {}) as Record<string, unknown>;
  const externalAgentId = profile?.externalAgentId ?? null;
  const deleteAdapter = profile?.adapterType
    ? getAdapter(profile.adapterType)
    : null;

  // Best-effort runtime-side cleanup. Only attempt when we have an
  // externalAgentId and a registered adapter; legacy rows (pre-1:1
  // mapping) won't have an externalAgentId and their config is shared
  // with siblings, so deprovision would delete nothing useful anyway.
  // Each adapter decides what "deprovision" means: OpenClaw drops the
  // gateway agent + workspace; Hermes is a no-op (no per-agent state).
  if (deleteAdapter && externalAgentId) {
    try {
      await deleteAdapter.deprovision({
        adapterConfig: config,
        externalAgentId,
      });
    } catch (err) {
      log.warn({ err, deploymentId: existing.id }, "deprovision threw");
    }
  }

  // Pre-delete reparent: if retiring a head, slide its specialists back
  // to the CEO. Without this, the children's parent_deployment_index
  // points at a deleted row and listSubordinates returns empty via the
  // null-parent defensive guard. Reparent BEFORE delete so the parent
  // index briefly overlaps (no FK constraint on parent_index — it's an
  // integer denormalised reference).
  if (getTier(existing.role) === "head") {
    try {
      await reparentOnHeadRetire({
        companyId: existing.companyId!,
        retiringHeadDeploymentId: existing.id,
        retiringHeadDeploymentIndex: existing.deploymentIndex!,
      });
    } catch (err) {
      log.warn(
        { err, deploymentId: existing.id, role: existing.role },
        "reparentOnHeadRetire threw — retire continues, children may be orphaned",
      );
    }
  }

  await db.delete(deployments).where(eq(deployments.id, existing.id));
  res.json({ ok: true });
});

export default router;
