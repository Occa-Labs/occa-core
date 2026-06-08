// Switch an already-deployed agent from one runtime adapter to another
// (e.g. openclaw → hermes). The agent's identity, deployment row,
// hierarchy, seat, and OCCA-side task history are NOT touched — only the
// runtime profile (adapterType + adapterConfig + externalAgentId) is
// re-pointed.
//
// Strategy: "move then cut". Provision + seed on the TARGET runtime first;
// only flip the runtime-profile pointer once the new runtime is fully
// ready. If any step before the flip fails, the old runtime is still
// serving and the deployment is unchanged — the agent never goes dark.
// After the flip, the OLD runtime's agent is deprovisioned best-effort
// (a failure there leaves an orphan to reap later, it does not fail the
// switch — the old gateway may be unreachable, which is often the very
// reason for switching).
//
// Skills are re-enqueued so the worker reinstalls them on the new runtime;
// the previous install lived on the old gateway and does not carry over.

import { eq } from "drizzle-orm";
import type { AgentRole } from "@occa/shared/types";
import { companies } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";
import { getAdapter } from "../../../lib/adapter-registry";
import {
  renderWorkspaceFiles,
  DEFAULT_PERSONA,
  roleLabelFor,
} from "../../../lib/workspace-templates";
import { enqueueSkillSyncs } from "../../skills/services/agent-skill-assign";
import {
  buildExternalAgentId,
  buildWorkspacePath,
} from "../domain/external-id";
import {
  updateProfileByDeploymentId,
  type AgentRuntimeProfileRow,
} from "../repositories/agent-runtime-profile";

const log = childLogger("switch-adapter");

export interface SwitchAdapterInput {
  deploymentId: string;
  companyId: string;
  role: AgentRole;
  name: string;
  persona: string | null;
  desiredSkills: string[];
  // Current runtime (deprovision target after the flip).
  oldAdapterType: string;
  oldAdapterConfig: Record<string, unknown>;
  oldExternalAgentId: string | null;
  // Destination runtime.
  targetAdapterType: string;
  targetAdapterConfig: Record<string, unknown>;
}

export type SwitchAdapterResult =
  | { ok: true; runtimeProfile: AgentRuntimeProfileRow }
  | {
      ok: false;
      code:
        | "validate_failed"
        | "probe_failed"
        | "provision_failed"
        | "seed_failed"
        | "persist_failed";
      message: string;
    };

export async function switchAdapter(
  input: SwitchAdapterInput,
): Promise<SwitchAdapterResult> {
  // 1. Resolve the destination adapter.
  const target = getAdapter(input.targetAdapterType);
  if (!target) {
    return {
      ok: false,
      code: "validate_failed",
      message: `unknown adapter type: ${input.targetAdapterType}`,
    };
  }

  // 2. Probe the destination before doing anything — refuse to move an
  //    agent onto a runtime we can't reach.
  const probe = await target.probeConnection(input.targetAdapterConfig);
  if (!probe.ok) {
    return {
      ok: false,
      code: "probe_failed",
      message: probe.error ?? "destination runtime unreachable",
    };
  }

  // 3. Prepare destination credentials (mints adapter-internal creds, e.g.
  //    an openclaw device keypair; hermes just validates the bearer).
  const creds = await target.prepareCredentials(input.targetAdapterConfig);
  if (!creds.ok) {
    return {
      ok: false,
      code: "validate_failed",
      message: `credentials failed: ${creds.error}${
        creds.reason ? ` — ${creds.reason}` : ""
      }`,
    };
  }
  const preparedConfig: Record<string, unknown> = {
    ...input.targetAdapterConfig,
    ...creds.configPatch,
  };

  // 4. External id is derived from the (stable) deployment id + role +
  //    name, so it is identical across runtimes — no churn in the UI's
  //    "External ID" beyond the runtime actually re-minting it.
  const externalAgentId = buildExternalAgentId(
    input.deploymentId,
    input.role,
    input.name,
  );
  const workspacePath = buildWorkspacePath(externalAgentId);

  // 5. Provision the agent on the destination runtime. Old runtime is
  //    still untouched here — a failure leaves the agent serving as-is.
  const provision = await target.provision({
    adapterConfig: preparedConfig,
    desiredExternalId: externalAgentId,
    workspacePath,
  });
  if (!provision.ok) {
    return {
      ok: false,
      code: "provision_failed",
      message: `provision failed: ${provision.error}${
        provision.reason ? ` — ${provision.reason}` : ""
      }`,
    };
  }
  const provisionedConfig: Record<string, unknown> = {
    ...preparedConfig,
    ...provision.configPatch,
  };

  // Helper to undo a half-done destination provision when a later step
  // fails before the pointer flip — keeps the destination clean so a
  // retry starts fresh instead of colliding with a stale external id.
  const cleanupDestination = async () => {
    try {
      await target.deprovision({
        adapterConfig: provisionedConfig,
        externalAgentId: provision.externalAgentId,
      });
    } catch (err) {
      log.warn(
        { err, externalAgentId: provision.externalAgentId },
        "destination cleanup deprovision failed",
      );
    }
  };

  // 6. Render the workspace (persona + role context) and seed it onto the
  //    destination runtime.
  const companyName = await resolveCompanyName(input.companyId);
  const now = new Date();
  const occaApiUrl =
    process.env.OCCA_API_URL ??
    `http://localhost:${process.env.PORT ?? "3002"}`;
  let rendered: Awaited<ReturnType<typeof renderWorkspaceFiles>>;
  try {
    rendered = await renderWorkspaceFiles({
      agent: {
        name: input.name,
        role: input.role,
        roleLabel: roleLabelFor(input.role),
        persona: input.persona ?? DEFAULT_PERSONA,
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
    await cleanupDestination();
    return {
      ok: false,
      code: "persist_failed",
      message: err instanceof Error ? err.message : "template render failed",
    };
  }

  const seed = await target.seedWorkspace({
    adapterConfig: provisionedConfig,
    externalAgentId: provision.externalAgentId,
    files: rendered.map((f) => ({ filename: f.filename, content: f.content })),
  });
  if (!seed.ok) {
    await cleanupDestination();
    return {
      ok: false,
      code: "seed_failed",
      message: `seed failed: ${seed.error}${
        seed.reason ? ` — ${seed.reason}` : ""
      }`,
    };
  }

  // 7. COMMIT POINT — flip the runtime-profile pointer. From here the
  //    dispatcher routes every task for this agent to the new runtime.
  const updated = await updateProfileByDeploymentId({
    deploymentId: input.deploymentId,
    patch: {
      adapterType: input.targetAdapterType,
      adapterConfig: provisionedConfig,
      externalAgentId: provision.externalAgentId,
      provisioningState: "ready",
      provisioningError: null,
      // Force the worker to reinstall skills on the new runtime.
      skillsInitializedAt: null,
    },
  });
  if (!updated) {
    await cleanupDestination();
    return {
      ok: false,
      code: "persist_failed",
      message: "runtime profile update returned no row",
    };
  }

  // 8. Best-effort deprovision the OLD runtime's agent. Never fails the
  //    switch — the old gateway is frequently the reason we're moving.
  if (input.oldExternalAgentId) {
    const old = getAdapter(input.oldAdapterType);
    if (old) {
      try {
        await old.deprovision({
          adapterConfig: input.oldAdapterConfig,
          externalAgentId: input.oldExternalAgentId,
        });
      } catch (err) {
        log.warn(
          {
            err,
            deploymentId: input.deploymentId,
            oldAdapterType: input.oldAdapterType,
          },
          "old runtime deprovision failed (orphan left for reaper)",
        );
      }
    }
  }

  // 9. Re-enqueue skill installs so the worker syncs them onto the new
  //    runtime. Non-critical — log and continue.
  if (input.desiredSkills.length > 0) {
    try {
      await enqueueSkillSyncs({
        deploymentId: input.deploymentId,
        companyId: input.companyId,
        skillKeys: input.desiredSkills,
      });
    } catch (err) {
      log.error({ err }, "enqueue skill syncs after switch failed (continuing)");
    }
  }

  log.info(
    {
      deploymentId: input.deploymentId,
      from: input.oldAdapterType,
      to: input.targetAdapterType,
    },
    "agent runtime switched",
  );
  return { ok: true, runtimeProfile: updated };
}

async function resolveCompanyName(companyId: string): Promise<string> {
  const [row] = await db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return row?.name ?? "Company";
}
