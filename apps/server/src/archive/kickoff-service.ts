/**
 * Kickoff orchestrator — drives the post-onboarding "CEO discovery → bulk
 * deploy → background provisioning → team meeting" flow.
 *
 * Surface area:
 *   - startKickoff(): validates input, patches company fields from the
 *     dialog answers, creates agent rows for each chosen role (status =
 *     pending), flips company.kickoff_state to 'provisioning', then
 *     spawns the async provisioning loop and returns immediately.
 *   - processKickoffProvisioning(): the async loop. For each pending
 *     agent: validateKeypair → provisionAgent → seed workspace, marking
 *     each ready / failed. When the queue drains, flips company state
 *     to 'completed'.
 *
 * Why sequential (not batched): config.patch with multiple new agents
 * per call is unverified on this gateway version; the existing single-
 * agent provision path is proven + idempotent. Sequential cost is
 * absorbed by running entirely off the request thread — the user sees
 * no spinner, only a progress banner that ticks up.
 */

import { eq, and, isNull } from "drizzle-orm";
import {
  deserializeKeypair,
  provisionAgent,
  seedWorkspace,
  validateDeviceKeypair,
} from "@occa/adapter-openclaw";
import { randomBytes } from "node:crypto";
import {
  agentIdentities,
  agentRuntimeProfile,
  companies,
  deploymentWorkspaceFiles,
  deployments,
} from "@occa/shared/schema";
import type { AgentRole } from "@occa/shared/types";
import {
  CEO_ROLE,
  ROLE_CATALOG,
  type RoleCategory as SharedRoleCategory,
} from "@occa/shared";
import { assignSeatForCompany } from "../features/agents/services/seat-assignment";
import {
  buildExternalAgentId,
  buildWorkspacePath,
} from "../features/agents/domain/external-id";
import { childLogger } from "../lib/logger";

const log = childLogger("kickoff");
import { db } from "../infra/database/client";
import { upsert as upsertCompanyProfile } from "../features/companies/repositories/company-profiles";
import { renderWorkspaceFiles, roleLabelFor } from "../lib/workspace-templates";
import {
  autoAssignSkillsToNewAgent,
  enqueueSkillSyncs,
} from "../features/skills/services/agent-skill-assign";

// Synthetic placeholder for chain-bound NOT NULL UNIQUE columns
// (agent_pubkey, identity_pda, deployment_pda). Chain step overwrites
// with real Solana pubkey/PDA values.
function synthPlaceholderKey(tag: string): string {
  return `${tag}_${randomBytes(24).toString("hex")}`;
}

// Gateway provisioning timeouts. Handshake is one round-trip; restart is
// the worst-case wait that includes restarting the gateway-side agent.
const GATEWAY_HANDSHAKE_TIMEOUT_MS = 30_000;
const GATEWAY_RESTART_TOTAL_TIMEOUT_MS = 180_000;

// ── Role catalog ─────────────────────────────────────────────────────────────
//
// Server-side view of the canonical catalog in @occa/shared. The kickoff
// dialog picks roles from this; agents-creation uses `defaultName` to seed
// the agent.name. `desiredSkills` is kickoff-only metadata (always empty
// today — placeholder for future curated skill bundles per role) and lives
// here rather than in shared because it's a server concern.

export type RoleCategory = SharedRoleCategory;

export interface RoleTemplate {
  key: AgentRole;
  defaultName: string;
  label: string;
  description: string;
  category: RoleCategory;
  desiredSkills: string[];
}

// Comprehensive role catalog. Covers C-suite, functional heads, IC/manager
// levels, plus crypto-native specialty roles. The kickoff dialog renders
// these as tag chips grouped by `category`; the server treats them as
// opaque slugs that feed straight into agents.role.
export const KICKOFF_ROLE_CATALOG: Record<AgentRole, RoleTemplate> =
  Object.fromEntries(
    ROLE_CATALOG.map((r) => [
      r.key,
      {
        key: r.key,
        defaultName: r.defaultName,
        label: r.label,
        description: r.description,
        category: r.category,
        desiredSkills: [],
      } satisfies RoleTemplate,
    ]),
  );

/** Cap on how many deployments the kickoff dialog can pick at once. The user can
 *  always grow the team afterwards via the Agents window. */
export const KICKOFF_MAX_DEPLOYMENTS = 3;

// Legacy presets kept as a fallback — the new tag picker UI sends `roles[]`
// directly. If a caller passes `preset` instead, it resolves to one of these.
export const TEAM_SIZE_PRESETS: Record<
  "bootstrap" | "standard" | "full",
  AgentRole[]
> = {
  bootstrap: ["cto", "cmo"],
  standard: ["cto", "cmo", "coo", "head_editorial"],
  full: ["cto", "cmo", "coo", "head_editorial", "head_design"],
};

// ── Input shape from the kickoff dialog ──────────────────────────────────────

export interface KickoffStartInput {
  // Discovery answers — patched into companies row
  description: string | null; // → mission (long-form)
  niche: string | null;
  audience: string | null; // → target_audience
  brandVoice: string | null;
  contentPillars: string[];
  // Execution
  rolesToDeploy: AgentRole[]; // resolved from preset OR à-la-carte picks
}

// ── Orchestrator entry ───────────────────────────────────────────────────────

export interface StartKickoffResult {
  ok: true;
  deployedAgentIds: string[];
}

/**
 * Phase 1 of the kickoff: synchronous DB writes only. Patches the company
 * fields, inserts agent rows for each chosen role (provisioning_state =
 * pending), flips the company kickoff_state to 'provisioning', and queues
 * the background provisioning job.
 *
 * Returns immediately — the caller (HTTP route) responds 202 to the UI,
 * which then subscribes to the SSE status stream for live updates.
 */
export async function startKickoff(
  companyId: string,
  input: KickoffStartInput,
): Promise<StartKickoffResult> {
  log.info(
    {
      companyId,
      roles: input.rolesToDeploy,
      niche: input.niche ?? null,
      audience: !!input.audience,
      voice: !!input.brandVoice,
    },
    "starting kickoff",
  );

  // Load the company + the existing CEO. The CEO row carries the gateway
  // adapter config (URL, apiKey, deviceKeypair) that every new deployment reuses.
  const [company] = await db
    .select()
    .from(companies)
    .where(and(eq(companies.id, companyId), isNull(companies.deletedAt)))
    .limit(1);
  if (!company) {
    log.error({ companyId }, "company not found");
    throw new Error("company_not_found");
  }

  // Idempotency — re-entering kickoff after a failed attempt is allowed,
  // but we don't want to double-deploy if a previous run already created
  // the agents.
  if (company.kickoffState === "provisioning") {
    log.warn(
      { kickoffState: company.kickoffState },
      "kickoff already in flight",
    );
    throw new Error(`kickoff_already_${company.kickoffState}`);
  }

  // Flip company core lifecycle to provisioning. Identity/profile fields
  // (mission, niche, target_audience, brand_voice, content_pillars) live
  // on the sibling company_profile table now and are upserted separately.
  await db
    .update(companies)
    .set({
      kickoffState: "provisioning",
      kickoffStartedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(companies.id, companyId));

  // Patch profile identity fields from discovery answers (only if non-null
  // — leave existing values intact for fields the user skipped).
  const profilePatch: Record<string, unknown> = {};
  if (input.description) profilePatch.mission = input.description;
  if (input.niche) profilePatch.niche = input.niche;
  if (input.audience) profilePatch.targetAudience = input.audience;
  if (input.brandVoice) profilePatch.brandVoice = input.brandVoice;
  if (input.contentPillars.length > 0)
    profilePatch.contentPillars = input.contentPillars;
  if (Object.keys(profilePatch).length > 0) {
    await upsertCompanyProfile({ companyId, patch: profilePatch });
  }

  // Find the existing CEO so new deployments can reuse its adapter credentials
  // (gatewayUrl, apiKey, deviceKeypair, deviceToken). Without this, each
  // new agent would prompt OpenClaw for its own pair approval — exactly
  // the UX problem we solved earlier with persistent device tokens.
  // Adapter config lives on agent_runtime_profile now; JOIN to surface
  // it alongside the deployment id used for parent linking.
  const [ceoRow] = await db
    .select({
      id: deployments.id,
      deploymentIndex: deployments.deploymentIndex,
      adapterConfig: agentRuntimeProfile.adapterConfig,
    })
    .from(deployments)
    .innerJoin(
      agentRuntimeProfile,
      eq(agentRuntimeProfile.deploymentId, deployments.id),
    )
    .where(
      and(eq(deployments.companyId, companyId), eq(deployments.role, CEO_ROLE)),
    )
    .limit(1);
  if (!ceoRow) {
    throw new Error("kickoff_requires_ceo");
  }
  const ceoAdapter = ceoRow.adapterConfig as Record<string, unknown>;

  log.info(
    {
      mission: !!input.description,
      niche: input.niche ?? null,
      audience: !!input.audience,
      voice: !!input.brandVoice,
      pillars: input.contentPillars.length,
    },
    "patched company identity fields from kickoff input",
  );

  // Insert pending agent rows. Each row is a real agents table entry with
  // provisioning_state='pending'. The async loop will fill in
  // externalAgentId + flip state to 'ready' once OpenClaw acknowledges.
  const deployedIds: string[] = [];
  for (const role of input.rolesToDeploy) {
    const tpl = KICKOFF_ROLE_CATALOG[role];
    if (!tpl) {
      log.warn({ role }, "skipping unknown role");
      continue;
    }

    // Assign a 3D seat for this deployment. Done per-iteration (sequential)
    // so each new agent's seat reflects all earlier deployments in this batch.
    const workstationId = await assignSeatForCompany({
      companyId,
      role: tpl.key,
    });
    if (!workstationId) {
      log.warn({ role: tpl.key }, "office full — skipping kickoff deployment");
      continue;
    }

    // 3-table insert per deployment: identity → deployment → runtime profile.
    // Identity ownerWallet comes from companies.ownerWallet (placeholder
    // if chain isn't registered yet). deploymentIndex serializes against
    // the unique (company_id, deployment_index) constraint.
    const inserted = await db.transaction(async (tx) => {
      const [companyOwner] = await tx
        .select({
          ownerUserId: companies.ownerUserId,
          ownerWallet: companies.ownerWallet,
        })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (!companyOwner) throw new Error("company_disappeared_mid_kickoff");
      const ownerWallet =
        companyOwner.ownerWallet ?? `placeholder:${companyId}`;

      const [identity] = await tx
        .insert(agentIdentities)
        .values({
          ownerUserId: companyOwner.ownerUserId,
          agentPubkey: synthPlaceholderKey("ag_pk"),
          identityPda: synthPlaceholderKey("ag_pda"),
          ownerWallet,
          name: tpl.defaultName,
        })
        .returning();

      const sibs = await tx
        .select({ idx: deployments.deploymentIndex })
        .from(deployments)
        .where(eq(deployments.companyId, companyId));
      const nextIdx =
        sibs.length === 0 ? 0 : Math.max(...sibs.map((r) => r.idx ?? 0)) + 1;

      const [deployment] = await tx
        .insert(deployments)
        .values({
          companyId,
          agentIdentityId: identity.id,
          deploymentPda: synthPlaceholderKey("dep_pda"),
          deploymentIndex: nextIdx,
          role: tpl.key,
          // CEO is parent; mirror its deploymentIndex (Option<u32> on chain).
          parentDeploymentIndex: ceoRow.deploymentIndex,
          status: "active",
        })
        .returning();

      // Seed runtime profile with shared CEO credentials. Persisting at
      // insert time (not after the async provision) matters: if
      // provisioning fails halfway, /reprovision has everything it needs
      // without falling back to lookup.
      await tx.insert(agentRuntimeProfile).values({
        deploymentId: deployment.id,
        companyId,
        adapterType: "openclaw",
        adapterConfig: {
          gatewayUrl: ceoAdapter.gatewayUrl,
          apiKey: ceoAdapter.apiKey,
          deviceKeypair: ceoAdapter.deviceKeypair,
          ...(typeof ceoAdapter.deviceToken === "string"
            ? { deviceToken: ceoAdapter.deviceToken }
            : {}),
        },
        provisioningState: "pending",
        workstationId,
      });

      return deployment;
    });
    deployedIds.push(inserted.id);
    log.info(
      { deploymentId: inserted.id, role: tpl.key, name: tpl.defaultName },
      "inserted pending deployment",
    );
  }

  log.info(
    { deploymentsQueued: deployedIds.length },
    "kickoff state set to provisioning, handing off to background worker",
  );

  // Spawn async work; do NOT await. We deliberately drop the promise so
  // the HTTP request returns quickly. Errors land in the per-agent row's
  // provisioning_error column + show in the SSE stream.
  void processKickoffProvisioning(companyId, deployedIds).catch((err) => {
    log.error({ err, companyId }, "background provisioning crashed");
  });

  return { ok: true, deployedAgentIds: deployedIds };
}

// ── Async provisioning loop ──────────────────────────────────────────────────

/**
 * Sequential provisioning pass. Each agent gets its own gateway round-trip
 * (config patch + restart wait), so the loop can take 30-90s for a full
 * team. Runs entirely off the request thread; UI subscribes to the SSE
 * status stream for per-agent progress.
 */
export async function processKickoffProvisioning(
  companyId: string,
  agentIds: string[],
): Promise<void> {
  const startedAt = Date.now();
  log.info(
    { companyId, deployments: agentIds.length },
    "background provisioning starting",
  );

  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!company) {
    log.warn({ companyId }, "company disappeared mid-flight");
    return;
  }

  const [ceoRow] = await db
    .select({
      id: deployments.id,
      adapterConfig: agentRuntimeProfile.adapterConfig,
    })
    .from(deployments)
    .innerJoin(
      agentRuntimeProfile,
      eq(agentRuntimeProfile.deploymentId, deployments.id),
    )
    .where(
      and(eq(deployments.companyId, companyId), eq(deployments.role, CEO_ROLE)),
    )
    .limit(1);
  if (!ceoRow) {
    log.warn("CEO missing, cannot provision new deployments");
    return;
  }
  const ceoAdapter = ceoRow.adapterConfig as Record<string, unknown>;
  const gatewayUrl = ceoAdapter.gatewayUrl as string;
  const apiKey = ceoAdapter.apiKey as string;
  const ceoDeviceToken =
    typeof ceoAdapter.deviceToken === "string"
      ? ceoAdapter.deviceToken
      : undefined;
  // CRITICAL: reuse CEO's keypair across all deployments. Generating a fresh
  // keypair per deployment creates a new "device" on the gateway → each one
  // requires manual pairing approval → the user is blocked. By sharing
  // CEO's already-paired keypair, every deployment connects under the same
  // device identity and is differentiated only by externalAgentId.
  // This mirrors the regular onboarding pattern (users.pendingDeviceKeypair).
  const ceoKeypairSerialized = ceoAdapter.deviceKeypair;
  if (!ceoKeypairSerialized || typeof ceoKeypairSerialized !== "object") {
    log.error("CEO has no deviceKeypair in adapterConfig, kickoff aborted");
    return;
  }
  const ceoKeypair = deserializeKeypair(
    ceoKeypairSerialized as Parameters<typeof deserializeKeypair>[0],
  );
  log.info(
    {
      gatewayUrl,
      apiKey: apiKey ? "present" : "missing",
      ceoDeviceToken: ceoDeviceToken ? "present" : "missing",
      ceoDeviceIdPrefix: ceoKeypair.deviceId.slice(0, 12),
    },
    "background provisioning context resolved",
  );

  let readyCount = 0;
  let failedCount = 0;

  // Process one agent at a time. Sequential is intentional: parallel
  // config.patch calls would race on the gateway's baseHash and one
  // would win, leaving the rest to retry.
  for (const [i, agentId] of agentIds.entries()) {
    // JOIN deployment + identity (name) + runtime profile (provisioning
    // state + adapter config) so the loop body still reads everything
    // off one denormalized object.
    const [agentRow] = await db
      .select({
        id: deployments.id,
        companyId: deployments.companyId,
        role: deployments.role,
        name: agentIdentities.name,
        provisioningState: agentRuntimeProfile.provisioningState,
      })
      .from(deployments)
      .innerJoin(
        agentIdentities,
        eq(deployments.agentIdentityId, agentIdentities.id),
      )
      .innerJoin(
        agentRuntimeProfile,
        eq(agentRuntimeProfile.deploymentId, deployments.id),
      )
      .where(eq(deployments.id, agentId))
      .limit(1);
    if (!agentRow) {
      log.warn(
        { agentId, index: i + 1, total: agentIds.length },
        "deployment row missing, skipping",
      );
      continue;
    }
    if (agentRow.provisioningState !== "pending") {
      log.info(
        {
          agentId,
          role: agentRow.role,
          provisioningState: agentRow.provisioningState,
          index: i + 1,
          total: agentIds.length,
        },
        "skipping non-pending deployment",
      );
      continue;
    }

    const t0 = Date.now();
    log.info(
      {
        agentId,
        role: agentRow.role,
        name: agentRow.name,
        index: i + 1,
        total: agentIds.length,
      },
      "provisioning deployment",
    );

    // Mark in-flight so SSE viewers can show "provisioning…" not just "pending".
    await db
      .update(agentRuntimeProfile)
      .set({ provisioningState: "provisioning", updatedAt: new Date() })
      .where(eq(agentRuntimeProfile.deploymentId, agentId));

    try {
      await provisionOne(
        { ...agentRow, companyId: agentRow.companyId! },
        gatewayUrl,
        apiKey,
        ceoKeypair,
        ceoKeypairSerialized as Parameters<typeof deserializeKeypair>[0],
        ceoDeviceToken,
      );

      // Auto-assign skills (lazy fetch from role defaults) + enqueue
      // installs. Both best-effort — failure here doesn't fail the
      // provisioning step itself, just delays skill availability.
      try {
        const assignedKeys = await autoAssignSkillsToNewAgent(
          agentRow.id,
          agentRow.role as AgentRole,
          companyId,
        );
        if (assignedKeys.length > 0) {
          await enqueueSkillSyncs({
            deploymentId: agentRow.id,
            companyId,
            skillKeys: assignedKeys,
          });
        }
      } catch (err) {
        log.warn(
          { err, agentId, role: agentRow.role },
          "skill assign/enqueue failed (continuing)",
        );
      }

      readyCount++;
      log.info(
        {
          agentId,
          role: agentRow.role,
          elapsedMs: Date.now() - t0,
          index: i + 1,
          total: agentIds.length,
        },
        "agent provisioned",
      );
    } catch (err) {
      failedCount++;
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          agentId,
          role: agentRow.role,
          elapsedMs: Date.now() - t0,
          index: i + 1,
          total: agentIds.length,
        },
        "agent provisioning failed",
      );
      await db
        .update(agentRuntimeProfile)
        .set({
          provisioningState: "failed",
          provisioningError: message.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(eq(agentRuntimeProfile.deploymentId, agentId));
      // Continue to next agent — partial team is better than full bail.
    }
  }

  // Whether all succeeded or some failed, mark kickoff complete. Failed deployments
  // stay in the team with provisioning_state='failed' — the user can reset
  // and re-pick if desired.
  await db
    .update(companies)
    .set({
      kickoffState: "completed",
      kickoffCompletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(companies.id, companyId));

  log.info(
    {
      companyId,
      ready: readyCount,
      failed: failedCount,
      elapsedMs: Date.now() - startedAt,
    },
    "background provisioning complete, kickoff state completed",
  );
}

interface PendingDeployment {
  id: string;
  companyId: string;
  role: string;
  name: string;
}

async function provisionOne(
  agentRow: PendingDeployment,
  gatewayUrl: string,
  apiKey: string,
  ceoKeypair: Awaited<ReturnType<typeof deserializeKeypair>>,
  ceoKeypairSerialized: Parameters<typeof deserializeKeypair>[0],
  ceoDeviceToken: string | undefined,
): Promise<void> {
  // Reuse CEO's already-paired keypair. The gateway treats every connect
  // under this keypair as the same device — no fresh pair approval. The
  // new deployment is differentiated only by externalAgentId. Same pattern as
  // users.pendingDeviceKeypair in the regular onboarding flow.
  const keypair = ceoKeypair;
  let deviceToken = ceoDeviceToken;
  log.info(
    {
      deviceIdPrefix: keypair.deviceId.slice(0, 12),
      hasToken: !!deviceToken,
    },
    "reusing CEO keypair for deployment",
  );

  log.info("validating device keypair against gateway");
  const validate = await validateDeviceKeypair(
    { gatewayUrl, apiKey },
    keypair,
    { deviceToken },
  );
  if (!validate.ok) {
    log.error(
      {
        agentId: agentRow.id,
        role: agentRow.role,
        error: validate.error,
        reason: validate.reason ?? null,
      },
      "validate_failed",
    );
    throw new Error(
      `validate_failed: ${validate.error}${validate.reason ? ` — ${validate.reason}` : ""}`,
    );
  }
  if (validate.deviceToken) deviceToken = validate.deviceToken;
  log.info("device keypair validated");

  const externalAgentId = buildExternalAgentId(
    agentRow.id,
    agentRow.role,
    agentRow.name,
  );
  const workspacePath = buildWorkspacePath(externalAgentId);

  log.info(
    { externalAgentId },
    "provisioning agent on gateway (triggers gateway restart, ~10-30s)",
  );
  // Bumped timeouts vs default — gateway is observed to take 15s+ for
  // handshake under sequential-restart load. With CEO probe, four deployment
  // probes from the worker, and kickoff config.patch all hammering the
  // gateway in parallel, defaults (10s handshake / 60s restart) starve.
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
      handshakeTimeoutMs: GATEWAY_HANDSHAKE_TIMEOUT_MS,
      restartTotalTimeoutMs: GATEWAY_RESTART_TOTAL_TIMEOUT_MS,
    },
  );
  if (!provision.ok) {
    log.error(
      {
        agentId: agentRow.id,
        role: agentRow.role,
        error: provision.error,
        reason: provision.reason ?? null,
      },
      "provision_failed",
    );
    throw new Error(
      `provision_failed: ${provision.error}${provision.reason ? ` — ${provision.reason}` : ""}`,
    );
  }
  if (provision.deviceToken) deviceToken = provision.deviceToken;
  log.info(
    {
      externalAgentId: provision.externalAgentId,
      workspacePath: provision.workspacePath,
    },
    "gateway acked provision",
  );

  // Persist CEO's serialized keypair onto the deployment's row — every connect
  // under this row will replay the same device identity.
  const serialized = ceoKeypairSerialized;

  // Flip externalAgentId + persist final adapter config (incl. rotated
  // device token if the gateway issued a new one during provision) on
  // the runtime profile.
  await db
    .update(agentRuntimeProfile)
    .set({
      externalAgentId: provision.externalAgentId,
      adapterConfig: {
        gatewayUrl,
        apiKey,
        deviceKeypair: serialized,
        ...(deviceToken ? { deviceToken } : {}),
        openclawAgentId: provision.externalAgentId,
        workspacePath: provision.workspacePath,
      },
      updatedAt: new Date(),
    })
    .where(eq(agentRuntimeProfile.deploymentId, agentRow.id));

  // Seed workspace files (skill catalog, README, etc) — same template
  // pipeline used by the direct deploy flow.
  const [companyRow] = await db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, agentRow.companyId))
    .limit(1);
  const companyName = companyRow?.name ?? "";
  const occaApiUrl =
    process.env.OCCA_API_URL ??
    `http://localhost:${process.env.PORT ?? "3002"}`;
  const now = new Date();
  log.info("rendering workspace files from templates");
  const rendered = await renderWorkspaceFiles({
    agent: {
      name: agentRow.name,
      role: agentRow.role,
      roleLabel: roleLabelFor(agentRow.role),
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
  log.info(
    {
      count: rendered.length,
      files: rendered.map((f) => ({
        filename: f.filename,
        origin: f.templateOrigin,
      })),
    },
    "rendered workspace files",
  );

  log.info("seeding workspace via gateway");
  await seedWorkspace({
    gatewayUrl,
    apiKey,
    device: deserializeKeypair(serialized),
    externalAgentId: provision.externalAgentId,
    files: rendered.map((f) => ({ filename: f.filename, content: f.content })),
  });
  log.info("workspace seeded");
  // Persist file inventory for the Agents window — same shape as the
  // direct deploy flow.
  await db.insert(deploymentWorkspaceFiles).values(
    rendered.map((f) => ({
      deploymentId: agentRow.id,
      companyId: agentRow.companyId,
      filename: f.filename,
      content: f.content,
      source: "template" as const,
      templateOrigin: f.templateOrigin,
      syncedAt: now,
    })),
  );

  // Mark ready.
  await db
    .update(agentRuntimeProfile)
    .set({
      provisioningState: "ready",
      provisioningError: null,
      updatedAt: new Date(),
    })
    .where(eq(agentRuntimeProfile.deploymentId, agentRow.id));
}
