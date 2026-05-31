// CEO Runs OS store — installable skill catalog + per-deployment
// installed snapshot. CEO uses this to decide what to install on whom
// via `[[OCCA:INSTALL_SKILL]]`. Loaded only when the calling deployment
// is CEO tier (gate lives in the assembler, not here).
//
// Two independent reads:
//   • Catalog — every skill visible to this company: built-ins
//     (`company_id IS NULL`) ∪ this company's own custom imports.
//   • Installed map — every active deployment's `desired_skills` array.
//
// Lightweight by design: catalog omits `markdown` (CEO doesn't need the
// full body, just key/name/description/allowedRoles to decide which to
// install). Renderer formats both as flat tables.

import { eq, isNull, ne, or, and, asc } from "drizzle-orm";
import {
  agentIdentities,
  agentRuntimeProfile,
  companySkills,
  companyTools,
  deploymentChannels,
  deployments,
  routineTriggers,
  routines,
  tasks,
  workflows,
} from "@occa/shared/schema";
import { CSUITE_ROLES, ROLE_CATALOG } from "@occa/shared/role-catalog";
import { db } from "../../../infra/database/client";
import { listAdapterTypes } from "../../../lib/adapter-registry";
import type {
  ContextBoardTask,
  ContextCeoOps,
  ContextChannelState,
  ContextInstallableSkill,
  ContextInstallableTool,
  ContextProposableRole,
  ContextProposableRuntime,
  ContextRoutineState,
  ContextWorkflowState,
} from "../spec";

export async function loadCeoOps(args: {
  companyId: string;
  // CEO's own deployment id — needed for the channels lookup since
  // deployment_channels is per-deployment and Channels v1 is CEO-only.
  ceoDeploymentId: string;
}): Promise<ContextCeoOps> {
  const [
    skillCatalogRows,
    toolCatalogRows,
    perDeploymentRows,
    channelRows,
    workflowRows,
    routineRows,
    routineTriggerRows,
    boardRows,
  ] = await Promise.all([
      db
        .select({
          key: companySkills.key,
          name: companySkills.name,
          description: companySkills.description,
          allowedRoles: companySkills.allowedRoles,
        })
        .from(companySkills)
        .where(
          or(
            isNull(companySkills.companyId),
            eq(companySkills.companyId, args.companyId),
          ),
        ),
      db
        .select({
          id: companyTools.id,
          type: companyTools.type,
          label: companyTools.label,
          status: companyTools.status,
          allowedRoles: companyTools.allowedRoles,
        })
        .from(companyTools)
        .where(eq(companyTools.companyId, args.companyId)),
      db
        .select({
          deploymentId: deployments.id,
          desiredSkills: agentRuntimeProfile.desiredSkills,
          enabledTools: agentRuntimeProfile.enabledTools,
        })
        .from(deployments)
        .innerJoin(
          agentRuntimeProfile,
          eq(agentRuntimeProfile.deploymentId, deployments.id),
        )
        .where(
          and(
            eq(deployments.companyId, args.companyId),
            eq(deployments.status, "active"),
          ),
        ),
      db
        .select({
          channelType: deploymentChannels.channelType,
          enabled: deploymentChannels.enabled,
          chatEnabled: deploymentChannels.chatEnabled,
          notifEnabled: deploymentChannels.notifEnabled,
          status: deploymentChannels.status,
        })
        .from(deploymentChannels)
        .where(eq(deploymentChannels.deploymentId, args.ceoDeploymentId)),
      db
        .select({
          yamlId: workflows.yamlId,
          name: workflows.name,
          description: workflows.description,
          enabled: workflows.enabled,
        })
        .from(workflows)
        .where(eq(workflows.companyId, args.companyId)),
      db
        .select({
          id: routines.id,
          title: routines.title,
          description: routines.description,
          status: routines.status,
          assigneeDeploymentId: routines.assigneeDeploymentId,
        })
        .from(routines)
        .where(eq(routines.companyId, args.companyId)),
      // Trigger join is its own query so a routine with multiple
      // triggers comes back as multiple rows we can fold by routineId
      // without inflating the parent listing.
      db
        .select({
          routineId: routineTriggers.routineId,
          kind: routineTriggers.kind,
          cronExpression: routineTriggers.cronExpression,
          timezone: routineTriggers.timezone,
          enabled: routineTriggers.enabled,
        })
        .from(routineTriggers)
        .innerJoin(routines, eq(routines.id, routineTriggers.routineId))
        .where(eq(routines.companyId, args.companyId)),
      // Active board — open tasks the CEO can move/remove. Left join the
      // assignee so unassigned tasks still appear. `done` excluded (it's
      // terminal + already in RECENT WORK); archived excluded.
      db
        .select({
          id: tasks.id,
          number: tasks.taskNumber,
          title: tasks.title,
          status: tasks.status,
          assigneeName: agentIdentities.name,
        })
        .from(tasks)
        .leftJoin(deployments, eq(tasks.assignedDeploymentId, deployments.id))
        .leftJoin(
          agentIdentities,
          eq(deployments.agentIdentityId, agentIdentities.id),
        )
        .where(
          and(
            eq(tasks.companyId, args.companyId),
            isNull(tasks.archivedAt),
            ne(tasks.status, "done"),
          ),
        )
        .orderBy(asc(tasks.taskNumber)),
    ]);

  const installableSkills: ContextInstallableSkill[] = skillCatalogRows.map(
    (r) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      allowedRoles: r.allowedRoles,
    }),
  );
  const installableTools: ContextInstallableTool[] = toolCatalogRows.map(
    (r) => ({
      id: r.id,
      type: r.type,
      label: r.label,
      status: r.status,
      allowedRoles: r.allowedRoles,
    }),
  );

  const installedByDeployment: Record<string, string[]> = {};
  const boundToolsByDeployment: Record<string, string[]> = {};
  for (const r of perDeploymentRows) {
    installedByDeployment[r.deploymentId] = r.desiredSkills;
    boundToolsByDeployment[r.deploymentId] = r.enabledTools;
  }

  const channels: ContextChannelState[] = channelRows.map((r) => ({
    channelType: r.channelType,
    enabled: r.enabled,
    chatEnabled: r.chatEnabled,
    notifEnabled: r.notifEnabled,
    status: r.status,
  }));

  const workflowsState: ContextWorkflowState[] = workflowRows.map((r) => ({
    yamlId: r.yamlId,
    name: r.name,
    description: r.description,
    enabled: r.enabled,
  }));

  // Fold trigger rows into a single human summary per routine. Disabled
  // triggers are skipped (they don't fire), so the summary reflects
  // actual firing cadence.
  const triggerSummaryById = new Map<string, string[]>();
  for (const t of routineTriggerRows) {
    if (!t.enabled) continue;
    const bucket = triggerSummaryById.get(t.routineId) ?? [];
    if (t.kind === "cron" && t.cronExpression) {
      const tz = t.timezone ?? "UTC";
      bucket.push(`cron ${t.cronExpression} (${tz})`);
    } else {
      bucket.push(t.kind);
    }
    triggerSummaryById.set(t.routineId, bucket);
  }
  const routinesState: ContextRoutineState[] = routineRows.map((r) => {
    const summaries = triggerSummaryById.get(r.id);
    const triggerSummary =
      summaries && summaries.length > 0 ? summaries.join("; ") : "no triggers";
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      assigneeDeploymentId: r.assigneeDeploymentId,
      triggerSummary,
    };
  });

  // Proposable catalogs are static (role catalog + adapter registry),
  // no DB read. Drop the ceo tier — one CEO per company, so the CEO can
  // never propose a second one.
  const proposableRoles: ContextProposableRole[] = ROLE_CATALOG.filter(
    (r) => r.tier !== "ceo",
  ).map((r) => ({
    key: r.key,
    label: r.label,
    tier: r.tier,
    description: r.description,
    // c-suite + head roles are one-per-company.
    singleton: CSUITE_ROLES.has(r.key) || r.tier === "head",
  }));
  const proposableRuntimes: ContextProposableRuntime[] = listAdapterTypes().map(
    (type) => ({ type }),
  );

  const activeTasks: ContextBoardTask[] = boardRows.map((r) => ({
    id: r.id,
    number: r.number,
    title: r.title,
    status: r.status,
    assigneeName: r.assigneeName,
  }));

  return {
    installableSkills,
    installableTools,
    installedByDeployment,
    boundToolsByDeployment,
    channels,
    workflows: workflowsState,
    routines: routinesState,
    activeTasks,
    proposableRoles,
    proposableRuntimes,
  };
}
