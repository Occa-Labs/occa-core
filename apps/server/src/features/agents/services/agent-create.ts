// Canonical create-agent pipeline. Mirrors the SSE-streamed flow in
// routes/agents.ts:254 but returns a single result instead of streaming
// step events — usable from non-HTTP callers (decide-handler `hire`
// branch).
//
// Steps (failures after step 3 trigger automatic rollback so we never
// leave a half-provisioned OCCA row):
//   1. Probe gateway creds
//   2. Generate + validate device keypair
//   3. INSERT agents row
//   4. provisionAgent (network)        rollback: deprovision + delete row
//   5. UPDATE agents with provision results
//   6. Render workspace templates
//   7. seedWorkspace RPC               rollback: deprovision + delete row
//   8. INSERT agent_workspace_files
//   9. autoAssignSkillsToNewAgent      → desiredSkills populated
//  10. INSERT pending agent_skill_syncs rows (worker picks them up)
//
// Skill installation itself runs async on the worker — we don't wait.
// First task dispatch can begin while skills are still installing; the
// agent has access to OpenClaw default tools (file IO, browser, exec)
// in the meantime.

import { eq } from "drizzle-orm";
import { normalizeGatewayUrl } from "../../../lib/gateway-url";
import { getAdapter } from "../../../lib/adapter-registry";
import { agents, agentWorkspaceFiles, companies } from "@occa/shared/schema";
import type { AgentRole } from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";

const log = childLogger("agent-create");
import {
  renderWorkspaceFiles,
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

export interface CreateAgentInternalInput {
  companyId: string;
  name: string;
  role: AgentRole;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  parentAgentId?: string | null;
}

export type CreateAgentInternalResult =
  | { ok: true; agent: typeof agents.$inferSelect }
  | {
      ok: false;
      code:
        | "probe_failed"
        | "validate_failed"
        | "db_insert_failed"
        | "provision_failed"
        | "seed_failed"
        | "post_seed_persist_failed"
        | "office_full";
      message: string;
    };

export async function createAgentInternal(
  input: CreateAgentInternalInput,
): Promise<CreateAgentInternalResult> {
  // 1. Resolve adapter + prepare credentials.
  // The adapter generates any internal credentials needed (e.g. Ed25519 keypair
  // for openclaw) and validates them against the remote, returning a configPatch
  // that is merged into adapterConfig before the DB insert.
  const adapter = getAdapter(input.adapterType);
  if (!adapter) {
    return {
      ok: false,
      code: "validate_failed",
      message: `unknown adapter type: ${input.adapterType}`,
    };
  }
  // Borrow paired device identity from any existing agent in this company.
  // The Hire-Agent modal only sends gatewayUrl + apiKey; without this
  // augmentation, prepareCredentials() generates a fresh keypair and the
  // gateway returns `pairing_required` even though the user already paired
  // during onboarding (CEO's keypair lives in agents.adapter_config). Mirrors
  // the keypair-sharing pattern used by kickoff-service for bulk hires.
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
  // Merged config used for DB insert and as the base for all subsequent adapter calls.
  const insertAdapterConfig: Record<string, unknown> = {
    ...augmentedConfig,
    ...creds.configPatch,
  };

  // Look up company name for workspace template rendering.
  const [companyRow] = await db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1);
  const companyName = companyRow?.name ?? "";

  // 3. Insert agents row (no externalAgentId yet — set after provision).
  //    Also assigns the 3D office seat at insert time. Done inside the
  //    DB step (not before) so concurrent hires can't race onto the same
  //    desk — the partial unique index on (company_id, workstation_id)
  //    catches collisions and retries via this loop.
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
  let agentRow: typeof agents.$inferSelect;
  try {
    const [row] = await db
      .insert(agents)
      .values({
        companyId: input.companyId,
        name: input.name,
        role: input.role,
        adapterType: input.adapterType,
        adapterConfig: insertAdapterConfig,
        parentAgentId: input.parentAgentId ?? null,
        workstationId,
      })
      .returning();
    agentRow = row;
  } catch (err) {
    return {
      ok: false,
      code: "db_insert_failed",
      message: err instanceof Error ? err.message : "agents insert failed",
    };
  }

  const externalAgentId = buildExternalAgentId(
    agentRow.id,
    agentRow.role,
    agentRow.name,
  );
  const workspacePath = buildWorkspacePath(externalAgentId);

  // Rollback helper — used after step 3 if any subsequent step fails.
  // Best-effort: tries to deprovision the gateway side (no-op if it
  // never got created), always deletes the OCCA row.
  const rollback = async (gatewayCreated: boolean) => {
    if (gatewayCreated) {
      try {
        await adapter.deprovision({
          adapterConfig: insertAdapterConfig,
          externalAgentId,
        });
      } catch (err) {
        log.warn(
          { err },
          `[agent-create] rollback deprovision failed external=${externalAgentId}`,
        );
      }
    }
    try {
      await db.delete(agents).where(eq(agents.id, agentRow.id));
    } catch (err) {
      log.warn(
        { err },
        `[agent-create] rollback delete failed agent=${agentRow.id}`,
      );
    }
  };

  // 4. Provision on the adapter side.
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

  // 5. Stamp provision results onto the agents row.
  const [updatedAgent] = await db
    .update(agents)
    .set({
      externalAgentId: provision.externalAgentId,
      adapterConfig: {
        ...insertAdapterConfig,
        ...provision.configPatch,
      },
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agentRow.id))
    .returning();

  // 6. Render workspace templates.
  const occaApiUrl =
    process.env.OCCA_API_URL ??
    `http://localhost:${process.env.PORT ?? "3002"}`;
  const now = new Date();
  let rendered: Awaited<ReturnType<typeof renderWorkspaceFiles>>;
  try {
    rendered = await renderWorkspaceFiles({
      agent: {
        name: input.name,
        role: input.role,
        roleLabel: roleLabelFor(input.role),
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

  // 7. Push workspace files via adapter.
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

  // 8. Persist workspace files locally.
  const syncedAt = new Date();
  try {
    await db.insert(agentWorkspaceFiles).values(
      rendered.map((f) => ({
        agentId: agentRow.id,
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

  // 9. Auto-assign skills (non-critical — log and continue if it fails).
  let finalRow = updatedAgent;
  let assignedKeys: string[] = [];
  try {
    assignedKeys = await autoAssignSkillsToNewAgent(
      updatedAgent.id,
      updatedAgent.role,
      input.companyId,
    );
    if (assignedKeys.length > 0) {
      finalRow = { ...updatedAgent, desiredSkills: assignedKeys };
    }
  } catch (err) {
    log.error({ err }, "auto-assign skills failed (continuing)");
  }

  // 10. Enqueue pending skill_syncs rows so the worker installs them
  //     immediately. Best-effort — failure here only delays installs
  //     until the lazy backfill (skills panel open) covers them.
  if (assignedKeys.length > 0) {
    try {
      await enqueueSkillSyncs({
        agentId: finalRow.id,
        companyId: input.companyId,
        skillKeys: assignedKeys,
      });
    } catch (err) {
      log.error({ err }, "enqueue skill syncs failed (continuing)");
    }
  }

  return { ok: true, agent: finalRow };
}

// Augment a (possibly minimal — gatewayUrl + apiKey only) adapter config
// with the paired device identity already stored on an agent in the same
// company **on the same gateway URL**. Pairing is per-(gatewayUrl, deviceId),
// so borrowing from an agent on a different gateway wouldn't help — the new
// gateway would still see an unrecognized device. Match uses normalized URL
// (scheme/case/trailing-slash agnostic) because stored URLs are `wss://...`
// post adapter rewrite while caller usually passes `https://...`.
async function augmentWithCompanyDeviceIdentity(args: {
  companyId: string;
  baseConfig: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  // Already populated (kickoff-service explicitly seeds this) → no lookup needed.
  if (args.baseConfig.deviceKeypair) return args.baseConfig;
  const gatewayUrl = args.baseConfig.gatewayUrl;
  if (typeof gatewayUrl !== "string") return args.baseConfig;

  const candidates = await db
    .select({ adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(eq(agents.companyId, args.companyId));
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
