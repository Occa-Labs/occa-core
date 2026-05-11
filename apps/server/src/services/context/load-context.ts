// Canonical context loader for the Tiered Hybrid Context Pipeline.
//
// Single source of truth — every prompt surface (chat, task, heartbeat)
// calls `loadContext()` and consumes the returned `ContextSpec`. No
// surface should JOIN `deployments` / `companies` / `agent_identities`
// directly anymore — duplicate logic was the bug this pipeline fixes.
//
// What's loaded by tier:
//   • Tier 1 — agent identity + company profile (always-on, every turn)
//   • Tier 2 — org chart (active team, capability gaps, subordinates
//              for self). Loaded fresh each call — tiny query cost,
//              avoids staleness when owner deploys mid-conversation.
//   • Tier 3 — knowledge + history. Left undefined until those tables
//              exist; renderers gracefully handle absence.
//   • Tier 4 — workspace files at gateway (not part of the spec).
//
// Cross-cutting placement: lives in `services/` rather than under any
// `features/<x>/` because three independent features (chat, tasks,
// future heartbeat) share it. Importing from features.repositories is
// allowed for service-tier code per CLAUDE.md (the cross-feature ban
// applies feature-to-feature, not service-to-feature).

import { and, eq, inArray } from "drizzle-orm";
import {
  ROLE_CATALOG,
  getTier,
  roleLabelFor,
  type RoleDefinition,
} from "@occa/shared/role-catalog";
import {
  agentIdentities,
  companies,
  companyBrain,
  companyProfile,
  deployments,
} from "@occa/shared/schema";
import { db } from "../../infra/database/client";
import { listSubordinates } from "../../features/agents/services/deployment-hierarchy";
import {
  listByAnyTag as listDocumentsByAnyTag,
  listRecent as listRecentDocuments,
} from "../../features/documents/repositories/documents";
import { listRecentDoneTasksByCompany } from "../../features/tasks/repositories/tasks";
import type {
  ContextAgent,
  ContextBrainFile,
  ContextCompany,
  ContextCompanyProfile,
  ContextHistory,
  ContextKnowledge,
  ContextOrg,
  ContextSpec,
  ContextTeammate,
  SurfacePayload,
} from "./spec";

// Tier 3b knobs. Tight by default — history is supplementary signal, not
// the main payload. Renderers can decide whether to embed full content
// or just the snippet for each item. Adjust if quality testing shows we
// need more / less recall.
const HISTORY_RECENT_TASKS_LIMIT = 5;
const HISTORY_RELEVANT_DOCS_LIMIT = 5;
const HISTORY_DOC_SNIPPET_LEN = 240;

const EMPTY_PROFILE: ContextCompanyProfile = {
  tagline: null,
  niche: null,
  brandVoice: null,
  contentPillars: [],
  forbiddenWords: [],
  coverageScope: null,
  coverageExcluded: null,
};

// Returns the full set of catalog roles in the default 35-persona org
// chart by walking the CEO entry's `manages` tree. Used to compute
// capability gaps. Excludes the CEO entry itself.
function defaultOrgChartRoles(): RoleDefinition[] {
  const ceoEntry = ROLE_CATALOG.find((r) => r.tier === "ceo");
  if (!ceoEntry) return [];
  const out: RoleDefinition[] = [];
  const seen = new Set<string>();
  const collect = (roleKey: string) => {
    if (seen.has(roleKey)) return;
    seen.add(roleKey);
    const def = ROLE_CATALOG.find((r) => r.key === roleKey);
    if (!def) return;
    out.push(def);
    for (const sub of def.manages) collect(sub);
  };
  for (const direct of ceoEntry.manages) collect(direct);
  return out;
}

export class ContextNotFoundError extends Error {
  constructor(deploymentId: string) {
    super(`No deployment found for id ${deploymentId}`);
    this.name = "ContextNotFoundError";
  }
}

export async function loadContext(args: {
  deploymentId: string;
  surface: SurfacePayload;
}): Promise<ContextSpec> {
  // Tier 1 — identity + company core. One JOIN gets all of it.
  const [head] = await db
    .select({
      agentName: agentIdentities.name,
      agentRole: deployments.role,
      companyId: deployments.companyId,
      companyName: companies.name,
    })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .innerJoin(companies, eq(deployments.companyId, companies.id))
    .where(eq(deployments.id, args.deploymentId))
    .limit(1);

  if (!head) throw new ContextNotFoundError(args.deploymentId);

  // Tier 1 — company_profile (1:1 sibling, may be missing).
  const [profileRow] = await db
    .select({
      tagline: companyProfile.tagline,
      niche: companyProfile.niche,
      brandVoice: companyProfile.brandVoice,
      contentPillars: companyProfile.contentPillars,
      forbiddenWords: companyProfile.forbiddenWords,
      coverageScope: companyProfile.coverageScope,
      coverageExcluded: companyProfile.coverageExcluded,
    })
    .from(companyProfile)
    .where(eq(companyProfile.companyId, head.companyId))
    .limit(1);

  const profile: ContextCompanyProfile = profileRow
    ? {
        tagline: profileRow.tagline,
        niche: profileRow.niche,
        brandVoice: profileRow.brandVoice,
        contentPillars: profileRow.contentPillars ?? [],
        forbiddenWords: profileRow.forbiddenWords ?? [],
        coverageScope: profileRow.coverageScope,
        coverageExcluded: profileRow.coverageExcluded,
      }
    : EMPTY_PROFILE;

  const agent: ContextAgent = {
    id: args.deploymentId,
    name: head.agentName,
    role: head.agentRole,
    roleLabel: roleLabelFor(head.agentRole),
    tier: getTier(head.agentRole) ?? "unknown",
  };
  const company: ContextCompany = {
    id: head.companyId,
    name: head.companyName,
    profile,
  };

  // Tier 2 — org chart. Active deployments in same company + role-catalog gap.
  const teamRows = await db
    .select({
      id: deployments.id,
      role: deployments.role,
      name: agentIdentities.name,
    })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(
      and(
        eq(deployments.companyId, head.companyId),
        eq(deployments.status, "active"),
      ),
    );

  const team: ContextTeammate[] = teamRows
    .filter((r) => r.id !== args.deploymentId)
    .map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      tier: (getTier(r.role) ?? "unknown") as ContextTeammate["tier"],
    }));

  const deployedRoles = new Set(teamRows.map((r) => r.role));
  const gaps = defaultOrgChartRoles()
    .filter((r) => !deployedRoles.has(r.key))
    .map((r) => ({
      role: r.key,
      tier: (getTier(r.key) ?? "unknown") as ContextTeammate["tier"],
    }));

  // Subordinates-for-self — what THIS agent can delegate to. CEO sees
  // everyone; a Head sees only their specialists; a specialist sees
  // nobody. Used by task surface for DELEGATE hints.
  const subordinatesRaw = await listSubordinates(args.deploymentId);
  const subordinatesForSelf: ContextTeammate[] = subordinatesRaw.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    tier: (getTier(r.role) ?? "unknown") as ContextTeammate["tier"],
  }));

  const org: ContextOrg = { team, gaps, subordinatesForSelf };

  // Tier 3 — Company Brain. Visibility-filtered to what THIS agent can see:
  //   • 'all'        — every active deployment
  //   • 'ceo_only'   — only the CEO tier
  //   • 'tier:head'  — CEO + Heads
  // Filter at query time so the renderer never sees blocks the agent
  // shouldn't have. Falls back to undefined when the company has no brain
  // rows yet — renderers `?? null`-handle that.
  const allowedVisibilities = visibilityScopesForTier(agent.tier);
  const brainRows =
    allowedVisibilities.length > 0
      ? await db
          .select({
            path: companyBrain.path,
            content: companyBrain.content,
          })
          .from(companyBrain)
          .where(
            and(
              eq(companyBrain.companyId, head.companyId),
              inArray(companyBrain.visibility, allowedVisibilities),
            ),
          )
          .orderBy(companyBrain.path)
      : [];

  const knowledge: ContextKnowledge | undefined =
    brainRows.length > 0
      ? {
          brain: brainRows.map(
            (r): ContextBrainFile => ({
              path: r.path,
              content: r.content,
              sizeBytes: Buffer.byteLength(r.content, "utf8"),
            }),
          ),
        }
      : undefined;

  // Tier 3b — history. Branched by surface kind so each surface gets the
  // most useful slice without paying for both queries:
  //   • chat  → "what did the team ship recently?" (recentCompletedTasks)
  //   • task  → "any prior work matching my tags?" (relevantDocuments)
  //             falls back to recentCompletedTasks when the task has no
  //             tags or no tag-matched docs exist.
  const history = await loadHistory({
    companyId: head.companyId,
    surface: args.surface,
  });

  return {
    agent,
    company,
    org,
    knowledge,
    history,
    surface: args.surface,
  };
}

async function loadHistory(args: {
  companyId: string;
  surface: SurfacePayload;
}): Promise<ContextHistory | undefined> {
  if (args.surface.kind === "chat") {
    const recent = await listRecentDoneTasksByCompany({
      companyId: args.companyId,
      limit: HISTORY_RECENT_TASKS_LIMIT,
    });
    if (recent.length === 0) return undefined;
    return {
      recentCompletedTasks: recent.map((t) => ({
        taskNumber: t.taskNumber,
        title: t.title,
        summary: extractResultPreview(t.blocks) ?? "(no result preview)",
      })),
    };
  }

  // task surface — tag-matched docs first, fallback to recent if empty.
  const tagged =
    args.surface.tags.length > 0
      ? await listDocumentsByAnyTag({
          companyId: args.companyId,
          tags: args.surface.tags,
          limit: HISTORY_RELEVANT_DOCS_LIMIT,
        })
      : [];

  const docs =
    tagged.length > 0
      ? tagged
      : await listRecentDocuments({
          companyId: args.companyId,
          limit: HISTORY_RELEVANT_DOCS_LIMIT,
        });

  if (docs.length === 0) return undefined;
  return {
    relevantDocuments: docs.map((d) => ({
      id: d.id,
      title: d.title,
      snippet: d.content.slice(0, HISTORY_DOC_SNIPPET_LEN),
    })),
  };
}

// Pull the agent_result preview out of a task's blocks JSON. Matches the
// shape persisted by the dispatcher in closeSucceededTrace. Returns null
// when no agent_result block exists (task done by human action, etc.).
function extractResultPreview(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (
      b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "agent_result"
    ) {
      const preview = (b as { preview?: unknown }).preview;
      if (typeof preview === "string") return preview;
    }
  }
  return null;
}

// What visibility tiers should this agent see? CEO = everything; Heads =
// `all` + `tier:head`; specialists = `all` only. Returning [] would mean
// "no rows" — every agent today sees at least `all`, so we never return [].
function visibilityScopesForTier(
  tier: ContextAgent["tier"],
): string[] {
  if (tier === "ceo") return ["all", "ceo_only", "tier:head"];
  if (tier === "head") return ["all", "tier:head"];
  return ["all"];
}
