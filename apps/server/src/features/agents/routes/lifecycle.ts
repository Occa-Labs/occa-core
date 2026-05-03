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
import {
  deprovisionAgent,
  deserializeKeypair,
  generateEphemeralKeypair,
  probeConnection,
  provisionAgent,
  seedWorkspace,
  serializeKeypair,
  validateDeviceKeypair,
  type SerializedKeypair,
} from "@occa/adapter-openclaw";
import {
  agents,
  agentWorkspaceFiles,
  companies,
  users,
} from "@occa/shared/schema";
import type {
  CreateAgentResponse,
  ListAgentFilesResponse,
  ListAgentsResponse,
} from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import { findOwnedByUserId } from "../repositories/agents";
import { findByCompanyId as findCompanyProfileByCompanyId } from "../../companies/repositories/company-profiles";
import { requireAuth } from "../../../middleware/auth";
import { toCompanyDTO } from "../../companies/domain/dto";
import { hydrateAgentDTO, hydrateAgentDTOs } from "../services/agent-status";
import {
  autoAssignSkillsToNewAgent,
  enqueueSkillSyncs,
} from "../../skills/services/agent-skill-assign";
import { wouldCreateCycle } from "../services/agent-hierarchy";
import {
  renderWorkspaceFiles,
  roleLabelFor,
} from "../../../lib/workspace-templates";
import { assignSeatForCompany } from "../services/seat-assignment";
import { ALL_DESKS } from "@occa/shared/seating";
import { CEO_ROLE } from "@occa/shared/role-catalog";
import { PG_ERROR_CODES } from "../../../lib/pg-errors";
import {
  buildExternalAgentId,
  buildWorkspacePath,
} from "../domain/external-id";
import {
  createAgentBody,
  patchAgentBody,
} from "../domain/schemas";
import { log } from "./_shared";

const router: Router = Router();

// Local helper — single-row read used by the create flow's gating (do
// we need to demand a `companyName` from the caller?). The owner-scoped
// agent lookups go through `findOwnedByUserId` instead.
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
router.post("/", requireAuth, async (req: Request, res: Response) => {
  const parsed = createAgentBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }
  const userId = req.user!.userId;
  const { name, role, adapterType, adapterConfig, companyName } = parsed.data;

  const existingCompanyId = await userCompanyId(userId);
  if (!existingCompanyId && !companyName) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.COMPANY_REQUIRED });
    return;
  }

  // Switch to SSE from here — all subsequent errors are streamed.
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
  const stepDone = (step: string) =>
    emit("step", { status: "done", step });
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

  // Load or lazily create a per-user persistent keypair so the SAME
  // identity is used for the probe, validate, and provision calls.
  // Effect: the user approves OpenClaw pairing exactly once — every
  // subsequent connect (retry, launch, re-onboarding) reuses the
  // already-approved device.
  //
  // Once paired, the gateway issues a deviceToken
  // (hello-ok.auth.deviceToken) which is replayed on subsequent connects
  // to skip re-pair prompts even across gateway restarts.
  //
  // Lookup priority (agents > pendingDeviceKeypair):
  //   1. Any existing agent in this user's company — agents are the
  //      source of truth for the paired device identity.
  //   2. users.pendingDeviceKeypair — fallback only when no agent exists
  //      yet (initial onboarding). Earlier code prioritized this and
  //      drifted: stale fresh keypair stuck here while real paired one
  //      lived on agents → second hire kept failing pairing.
  //   3. Generate fresh + persist (first-ever onboarding).
  type StoredDeviceState = SerializedKeypair & { deviceToken?: string };

  let keypair;
  let deviceToken: string | undefined;

  // Pairing is per-(gatewayUrl, deviceId). Pull all agents in user's
  // company and filter by *normalized* gatewayUrl in JS — stored URLs are
  // `wss://...` (post adapter scheme rewrite) while probe input is usually
  // `https://...` with possible trailing slash, so a SQL `=` would miss.
  const userAgents = await db
    .select({ adapterConfig: agents.adapterConfig })
    .from(agents)
    .innerJoin(companies, eq(agents.companyId, companies.id))
    .where(
      and(
        eq(companies.ownerUserId, userId),
        eq(companies.kind, "user"),
        isNull(companies.deletedAt),
      ),
    );
  const probeKey = normalizeGatewayUrl(adapterConfig.gatewayUrl);
  const existingAgent = userAgents.find((row) => {
    const cfg = row.adapterConfig as Record<string, unknown> | undefined;
    const stored = cfg?.gatewayUrl;
    return typeof stored === "string" && normalizeGatewayUrl(stored) === probeKey;
  });
  const agentCfg = existingAgent?.adapterConfig as
    | Record<string, unknown>
    | undefined;
  const agentKeypair = agentCfg?.deviceKeypair as
    | SerializedKeypair
    | null
    | undefined;
  const agentKeypairValid =
    !!agentKeypair &&
    typeof agentKeypair.deviceId === "string" &&
    typeof agentKeypair.publicKey === "string" &&
    typeof agentKeypair.privateKeyHex === "string";

  if (agentKeypairValid) {
    keypair = deserializeKeypair(agentKeypair);
    deviceToken =
      typeof agentCfg?.deviceToken === "string" ? agentCfg.deviceToken : undefined;
  } else {
    const [userRow] = await db
      .select({ pendingDeviceKeypair: users.pendingDeviceKeypair })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const stored = userRow?.pendingDeviceKeypair as
      | StoredDeviceState
      | null
      | undefined;
    if (stored?.deviceId) {
      keypair = deserializeKeypair(stored);
      deviceToken = stored.deviceToken;
    } else {
      keypair = await generateEphemeralKeypair();
      await db
        .update(users)
        .set({ pendingDeviceKeypair: serializeKeypair(keypair) })
        .where(eq(users.id, userId));
    }
  }

  // Validate gateway access using the persistent device + replay token.
  const probe = await probeConnection(adapterConfig, {
    device: keypair,
    deviceToken,
  });
  if (!probe.ok) {
    fail(`adapter_probe_failed: ${probe.error}`);
    return;
  }
  if (probe.info?.deviceToken) deviceToken = probe.info.deviceToken;

  const validate = await validateDeviceKeypair(adapterConfig, keypair, {
    deviceToken,
  });
  if (!validate.ok) {
    fail(
      `validate_failed: ${validate.error}${validate.reason ? ` — ${validate.reason}` : ""}`,
    );
    return;
  }
  if (validate.deviceToken) deviceToken = validate.deviceToken;

  const serialized = serializeKeypair(keypair);

  // Step 1: DB transaction
  stepStart("creating_record", "Creating agent record");
  let companyRow: typeof companies.$inferSelect | null = null;
  let agentRow: typeof agents.$inferSelect;
  try {
    const tx = await db.transaction(async (t) => {
      let cid = existingCompanyId;
      let createdCompanyRow: typeof companies.$inferSelect | null = null;
      if (!cid) {
        const [inserted] = await t
          .insert(companies)
          .values({ ownerUserId: userId, name: companyName!, kind: "user" })
          .returning();
        createdCompanyRow = inserted;
        cid = inserted.id;
      }
      // Assign 3D seat — pure algorithm against the current occupied set.
      // Done inside the transaction so a concurrent hire on the same
      // company can't pick the same desk before we commit.
      const workstationId = await assignSeatForCompany({
        companyId: cid,
        role,
      });
      if (!workstationId) {
        throw new Error("office_full");
      }
      const [aRow] = await t
        .insert(agents)
        .values({
          companyId: cid,
          name,
          role,
          adapterType,
          adapterConfig: {
            gatewayUrl: adapterConfig.gatewayUrl,
            apiKey: adapterConfig.apiKey,
            deviceKeypair: serialized,
            ...(deviceToken ? { deviceToken } : {}),
          },
          workstationId,
        })
        .returning();
      return { aRow, createdCompanyRow };
    });
    agentRow = tx.aRow;
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
    fail(
      err instanceof Error ? err.message : "db_error",
      "creating_record",
    );
    return;
  }
  stepDone("creating_record");

  // Step 2: Provision on gateway (may emit gateway_restart substep)
  stepStart("provisioning", "Provisioning on gateway");
  const companyId = agentRow.companyId;
  const externalAgentId = buildExternalAgentId(agentRow.id);
  const workspacePath = buildWorkspacePath(externalAgentId);

  let restartStepEmitted = false;
  const provision = await provisionAgent(
    {
      gatewayUrl: adapterConfig.gatewayUrl,
      apiKey: adapterConfig.apiKey,
      device: keypair,
      deviceToken,
      desiredId: externalAgentId,
      workspacePath,
    },
    {
      onStep: (event) => {
        if (event === "restart_detected") {
          stepDone("provisioning");
          stepStart("gateway_restart", "Waiting for gateway restart");
          restartStepEmitted = true;
        } else if (event === "restart_verified") {
          stepDone("gateway_restart");
          stepStart("provisioning", "Verifying provision");
        }
      },
    },
  );
  if (provision.ok && provision.deviceToken) deviceToken = provision.deviceToken;

  if (!provision.ok) {
    const currentStep = restartStepEmitted ? "gateway_restart" : "provisioning";
    fail(
      `provision_failed: ${provision.error}${provision.reason ? ` — ${provision.reason}` : ""}`,
      currentStep,
      { agentId: agentRow.id, retryable: true },
    );
    return;
  }
  stepDone("provisioning");

  const [updatedAgent] = await db
    .update(agents)
    .set({
      externalAgentId: provision.externalAgentId,
      adapterConfig: {
        gatewayUrl: adapterConfig.gatewayUrl,
        apiKey: adapterConfig.apiKey,
        deviceKeypair: serialized,
        ...(deviceToken ? { deviceToken } : {}),
        openclawAgentId: provision.externalAgentId,
        workspacePath: provision.workspacePath,
      },
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agentRow.id))
    .returning();

  // Step 3: Seed workspace files
  stepStart("seeding_workspace", "Seeding workspace files");
  const occaApiUrl =
    process.env.OCCA_API_URL ?? `http://localhost:${process.env.PORT ?? "3002"}`;
  const now = new Date();
  let rendered: Awaited<ReturnType<typeof renderWorkspaceFiles>>;
  try {
    rendered = await renderWorkspaceFiles({
      agent: { name, role, roleLabel: roleLabelFor(role) },
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
      { agentId: agentRow.id, retryable: true },
    );
    return;
  }

  if (!companyRow) {
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

  const seed = await seedWorkspace({
    gatewayUrl: adapterConfig.gatewayUrl,
    apiKey: adapterConfig.apiKey,
    device: keypair,
    externalAgentId: provision.externalAgentId,
    files: rendered.map((f) => ({ filename: f.filename, content: f.content })),
  });
  if (!seed.ok) {
    fail(
      `seed_failed: ${seed.error}${seed.reason ? ` — ${seed.reason}` : ""}`,
      "seeding_workspace",
      { agentId: agentRow.id, retryable: true },
    );
    return;
  }

  const syncedAt = new Date();
  try {
    await db.insert(agentWorkspaceFiles).values(
      rendered.map((f) => ({
        agentId: agentRow.id,
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
      { agentId: agentRow.id, retryable: true },
    );
    return;
  }
  stepDone("seeding_workspace");

  // Step 4: Auto-assign skills + enqueue installs (non-critical)
  stepStart("assigning_skills", "Assigning skills");
  let finalRow = updatedAgent;
  try {
    const keys = await autoAssignSkillsToNewAgent(
      updatedAgent.id,
      updatedAgent.role,
      companyId,
    );
    if (keys.length > 0) {
      finalRow = { ...updatedAgent, desiredSkills: keys };
      await enqueueSkillSyncs({
        agentId: updatedAgent.id,
        companyId,
        skillKeys: keys,
      });
    }
  } catch (err) {
    log.error({ err }, "auto-assign / enqueue skills failed");
  }
  stepDone("assigning_skills");

  // Keypair has migrated to agent.adapter_config.deviceKeypair — drop the
  // pending copy so a future onboarding (e.g. second wallet) starts with
  // a clean slate instead of inheriting a stale identity.
  await db
    .update(users)
    .set({ pendingDeviceKeypair: null })
    .where(eq(users.id, userId));

  const companyProfileRow = companyRow
    ? await findCompanyProfileByCompanyId(companyRow.id)
    : null;
  const body: CreateAgentResponse = {
    agent: await hydrateAgentDTO(finalRow),
    company: companyRow ? toCompanyDTO(companyRow, companyProfileRow) : undefined,
  };
  emit("done", body);
  res.end();
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
    const agentRecord = await findOwnedByUserId({
      userId: req.user!.userId,
      agentId: req.params.id,
    });
    if (!agentRecord) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }

    let cfg = (agentRecord.adapterConfig ?? {}) as Record<string, unknown>;

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
      const [ceo] = await db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.companyId, agentRecord.companyId),
            eq(agents.role, CEO_ROLE),
          ),
        )
        .limit(1);
      const ceoCfg = (ceo?.adapterConfig ?? {}) as Record<string, unknown>;
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
      // Preserve per-agent extras the row already had (e.g.
      // openclawAgentId, workspacePath from a prior partial provision),
      // then overlay CEO credentials. Order matters: per-agent fields
      // first, credentials last so the broken baseline gets repaired.
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
        .update(agents)
        .set({ adapterConfig: merged, updatedAt: new Date() })
        .where(eq(agents.id, agentRecord.id));
      log.info(
        { agentId: agentRecord.id, role: agentRecord.role },
        "reprovision: backfilled adapter creds from CEO keypair",
      );
    }

    const gatewayUrl = cfg.gatewayUrl as string;
    const apiKey = cfg.apiKey as string;
    const keypair = deserializeKeypair(cfg.deviceKeypair as SerializedKeypair);
    // Replay the previously-issued device token (if any) so the gateway
    // resolves the existing pair instead of asking the user to approve
    // again.
    let deviceToken: string | undefined =
      typeof cfg.deviceToken === "string" ? cfg.deviceToken : undefined;
    const externalAgentId =
      agentRecord.externalAgentId ?? buildExternalAgentId(agentRecord.id);
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
      emit("error", { message, step, agentId: agentRecord.id, retryable: true });
      res.end();
    };

    // Step: provisioning
    stepStart("provisioning", "Provisioning on gateway");
    let restartStepEmitted = false;
    const provision = await provisionAgent(
      {
        gatewayUrl,
        apiKey,
        device: keypair,
        deviceToken,
        desiredId: externalAgentId,
        workspacePath,
      },
      {
        onStep: (event) => {
          if (event === "restart_detected") {
            stepDone("provisioning");
            stepStart("gateway_restart", "Waiting for gateway restart");
            restartStepEmitted = true;
          } else if (event === "restart_verified") {
            stepDone("gateway_restart");
            stepStart("provisioning", "Verifying provision");
          }
        },
      },
    );
    if (!provision.ok) {
      const currentStep = restartStepEmitted ? "gateway_restart" : "provisioning";
      fail(
        `provision_failed: ${provision.error}${provision.reason ? ` — ${provision.reason}` : ""}`,
        currentStep,
      );
      return;
    }
    stepDone("provisioning");
    if (provision.deviceToken) deviceToken = provision.deviceToken;

    await db
      .update(agents)
      .set({
        externalAgentId: provision.externalAgentId,
        adapterConfig: {
          ...cfg,
          ...(deviceToken ? { deviceToken } : {}),
          openclawAgentId: provision.externalAgentId,
          workspacePath: provision.workspacePath,
        },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentRecord.id));

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
      .where(eq(companies.id, agentRecord.companyId))
      .limit(1);

    let rendered: Awaited<ReturnType<typeof renderWorkspaceFiles>>;
    try {
      rendered = await renderWorkspaceFiles({
        agent: {
          name: agentRecord.name,
          role: agentRecord.role,
          roleLabel: roleLabelFor(agentRecord.role),
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

    const seed = await seedWorkspace({
      gatewayUrl,
      apiKey,
      device: keypair,
      externalAgentId: provision.externalAgentId,
      files: rendered.map((f) => ({ filename: f.filename, content: f.content })),
    });
    if (!seed.ok) {
      fail(
        `seed_failed: ${seed.error}${seed.reason ? ` — ${seed.reason}` : ""}`,
        "seeding_workspace",
      );
      return;
    }

    // Upsert workspace files — replace any existing rows for this agent
    try {
      await db
        .delete(agentWorkspaceFiles)
        .where(eq(agentWorkspaceFiles.agentId, agentRecord.id));
      await db.insert(agentWorkspaceFiles).values(
        rendered.map((f) => ({
          agentId: agentRecord.id,
          companyId: agentRecord.companyId,
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
      const keys = await autoAssignSkillsToNewAgent(
        agentRecord.id,
        agentRecord.role,
        agentRecord.companyId,
      );
      if (keys.length > 0) {
        await enqueueSkillSyncs({
          agentId: agentRecord.id,
          companyId: agentRecord.companyId,
          skillKeys: keys,
        });
      }
    } catch (err) {
      log.error({ err }, "reprovision: auto-assign / enqueue skills failed");
    }
    stepDone("assigning_skills");

    // Mark the row healthy now that gateway provision + workspace seed +
    // skill assignment all completed. Without this, the agent stays in
    // its pre-retry state (e.g. `failed`) and the Overview tab keeps
    // showing the "Provisioning incomplete" banner even after a
    // successful retry.
    await db
      .update(agents)
      .set({
        provisioningState: "ready",
        provisioningError: null,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentRecord.id));

    const [finalRow] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentRecord.id))
      .limit(1);
    const companyProfileRow = companyRow
      ? await findCompanyProfileByCompanyId(companyRow.id)
      : null;
    const body: CreateAgentResponse = {
      agent: await hydrateAgentDTO(finalRow),
      company: companyRow ? toCompanyDTO(companyRow, companyProfileRow) : undefined,
    };
    emit("done", body);
    res.end();
  },
);

// GET /api/agents — list this company's agents.
router.get("/", requireAuth, async (req: Request, res: Response) => {
  const companyId = await userCompanyId(req.user!.userId);
  if (!companyId) {
    const body: ListAgentsResponse = { agents: [] };
    res.json(body);
    return;
  }
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const body: ListAgentsResponse = { agents: await hydrateAgentDTOs(rows) };
  res.json(body);
});

// GET /api/agents/:id — detail.
router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const existing = await findOwnedByUserId({
    userId: req.user!.userId,
    agentId: req.params.id,
  });
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  res.json({ agent: await hydrateAgentDTO(existing) });
});

// GET /api/agents/:id/files — list workspace files from
// agent_workspace_files.
router.get(
  "/:id/files",
  requireAuth,
  async (req: Request, res: Response) => {
    const existing = await findOwnedByUserId({
      userId: req.user!.userId,
      agentId: req.params.id,
    });
    if (!existing) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const rows = await db
      .select()
      .from(agentWorkspaceFiles)
      .where(eq(agentWorkspaceFiles.agentId, existing.id));
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
  },
);

// PATCH /api/agents/:id — edit name/role/adapterConfig
router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const existing = await findOwnedByUserId({
    userId: req.user!.userId,
    agentId: req.params.id,
  });
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }
  const parsed = patchAgentBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }
  const update: Partial<typeof agents.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (parsed.data.name !== undefined) update.name = parsed.data.name;
  if (parsed.data.role !== undefined) update.role = parsed.data.role;
  if (parsed.data.adapterConfig !== undefined) {
    const existingConfig =
      (existing.adapterConfig as Record<string, unknown>) ?? {};
    update.adapterConfig = {
      ...existingConfig,
      gatewayUrl: parsed.data.adapterConfig.gatewayUrl,
      apiKey: parsed.data.adapterConfig.apiKey,
    };
  }
  if (parsed.data.parentAgentId !== undefined) {
    const next = parsed.data.parentAgentId;
    if (next !== null) {
      // Parent must be a real agent in the same company AND not a
      // descendant of this agent (cycle prevention).
      const [parentRow] = await db
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, next))
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
    }
    update.parentAgentId = next;
  }
  if (parsed.data.workstationId !== undefined) {
    const next = parsed.data.workstationId;
    // Slug must match a real anchor — reserved zones (meeting/lobby/exec)
    // are intentionally allowed for manual override; auto-assign skips
    // them but the user is god here.
    if (!ALL_DESKS.has(next)) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.WORKSTATION_NOT_FOUND });
      return;
    }
    update.workstationId = next;
  }
  if (parsed.data.modelOverride !== undefined) {
    update.modelOverride = parsed.data.modelOverride;
  }
  if (Object.keys(update).length === 1) {
    res.json({ agent: await hydrateAgentDTO(existing) });
    return;
  }
  let row: typeof agents.$inferSelect;
  try {
    [row] = await db
      .update(agents)
      .set(update)
      .where(eq(agents.id, existing.id))
      .returning();
  } catch (err) {
    // Partial unique index `(company_id, workstation_id)` blocks moving
    // onto a desk another agent already owns — surface as a typed error
    // so the frontend can show "desk taken" instead of a generic 500.
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

  res.json({ agent: await hydrateAgentDTO(row) });
});

// DELETE /api/agents/:id — remove from gateway, then DB. Cascade clears
// tasks (set null), tokens, runtime state, sessions, traces.
router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  const existing = await findOwnedByUserId({
    userId: req.user!.userId,
    agentId: req.params.id,
  });
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
    return;
  }

  const config = (existing.adapterConfig ?? {}) as Record<string, unknown>;
  const gatewayUrl =
    typeof config.gatewayUrl === "string" ? config.gatewayUrl : null;
  const apiKey = typeof config.apiKey === "string" ? config.apiKey : null;
  const deviceKeypair = config.deviceKeypair;
  const externalAgentId = existing.externalAgentId;

  // Best-effort gateway cleanup. Only attempt when we have everything we
  // need to talk to OpenClaw; legacy rows (pre-1:1 mapping) won't have
  // an externalAgentId and their config is shared with siblings, so
  // deprovision would delete nothing useful anyway.
  if (gatewayUrl && apiKey && deviceKeypair && externalAgentId) {
    try {
      const device = deserializeKeypair(deviceKeypair as SerializedKeypair);
      const result = await deprovisionAgent({
        gatewayUrl,
        apiKey,
        device,
        externalAgentId,
      });
      if (!result.ok) {
        log.warn(
          {
            agentId: existing.id,
            externalAgentId,
            reason: result.reason ?? result.error,
          },
          "deprovision failed",
        );
      }
    } catch (err) {
      log.warn({ err, agentId: existing.id }, "deprovision threw");
    }
  }

  await db.delete(agents).where(eq(agents.id, existing.id));
  res.json({ ok: true });
});

export default router;
