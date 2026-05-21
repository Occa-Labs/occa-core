import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "../infra/database/client";
import {
  agentRuntimeProfile,
  companySkills,
  companyTools,
  deployments,
  users,
} from "@occa/shared/schema";
import {
  type AgentRole,
  type AgentToolDTO,
  type ListAgentToolsResponse,
  type MeResponse,
  type SkillDTO,
  type SkillFileEntry,
  type SkillSourceType,
} from "@occa/shared/types";
import { listCatalog } from "../features/tools/services/catalog-loader";
import {
  findById as findDocumentById,
  listByAnyTag as listDocumentsByAnyTag,
  listRecent as listRecentDocuments,
  type DocumentRow,
} from "../features/documents/repositories/documents";
import { requireAuth } from "../middleware/auth";
import { requireAgentToken } from "../middleware/agent-auth";
import {
  hydrateDeploymentDTO,
  hydrateDeploymentDTOs,
} from "../features/agents/services/deployment-status";
import { toCompanyDTO } from "../features/companies/domain/dto";
import { findActiveOwnerCompanyWithProfile } from "../features/companies/repositories/companies";
import { recoverFromChainIfMissing } from "../features/chain/services/chain-recovery";

const router: Router = Router();

// GET /api/me
router.get("/", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const [userRow] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!userRow) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: ERROR_CODES.USER_NOT_FOUND });
    return;
  }

  let loaded = await findActiveOwnerCompanyWithProfile(userId);

  // Chain-first recovery — DB cache may be empty (new device, DB wipe,
  // or onboarding via direct SDK). Per CLAUDE.md "Chain = truth, DB =
  // cache", look up the wallet's PDAs on-chain and rebuild the cache.
  // Only triggers when DB has nothing — happy path stays single-query.
  if (!loaded) {
    try {
      const result = await recoverFromChainIfMissing({
        userId,
        walletAddress: userRow.walletAddress,
      });
      if (result.recovered) {
        loaded = await findActiveOwnerCompanyWithProfile(userId);
      }
    } catch (err) {
      req.log.error({ err }, "chain recovery failed; serving empty /api/me");
    }
  }

  const deploymentRows = loaded
    ? await db
        .select()
        .from(deployments)
        .where(eq(deployments.companyId, loaded.company.id))
    : [];

  const response: MeResponse = {
    user: {
      id: userRow.id,
      walletAddress: userRow.walletAddress,
      isPlatform: userRow.isPlatform,
      createdAt: userRow.createdAt.toISOString(),
    },
    company: loaded ? toCompanyDTO(loaded.company, loaded.profile) : null,
    agents: await hydrateDeploymentDTOs(deploymentRows),
  };
  res.json(response);
});

// GET /api/me/agent — agent-token authenticated: return the deployment's own DTO.
router.get("/agent", requireAgentToken, async (req: Request, res: Response) => {
  const deploymentId = req.agent!.agentId;
  const [row] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!row) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.AGENT_NOT_FOUND });
    return;
  }
  res.json({ agent: await hydrateDeploymentDTO(row) });
});

function toSkillDTO(row: typeof companySkills.$inferSelect): SkillDTO {
  return {
    id: row.id,
    companyId: row.companyId,
    key: row.key,
    slug: row.slug,
    name: row.name,
    description: row.description,
    markdown: row.markdown,
    sourceType: row.sourceType as SkillSourceType,
    sourceLocator: row.sourceLocator,
    sourceRef: row.sourceRef,
    sourceOwner: row.sourceOwner,
    sourceRepo: row.sourceRepo,
    sourcePath: row.sourcePath,
    fileInventory: (row.fileInventory as SkillFileEntry[]) ?? [],
    allowedRoles: (row.allowedRoles as AgentRole[]) ?? [],
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// GET /api/me/agent/skills — full SkillDTO[] for every key in desiredSkills.
// Markdown is included so the agent can read instructions without a second
// round-trip. Files under the skill dir (scripts/references/assets) remain
// proxied through the /files route below.
router.get(
  "/agent/skills",
  requireAgentToken,
  async (req: Request, res: Response) => {
    const { agentId: deploymentId, companyId } = req.agent!;
    const [profileRow] = await db
      .select({ desiredSkills: agentRuntimeProfile.desiredSkills })
      .from(agentRuntimeProfile)
      .where(eq(agentRuntimeProfile.deploymentId, deploymentId))
      .limit(1);
    if (!profileRow) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }
    if (profileRow.desiredSkills.length === 0) {
      res.json({ skills: [] });
      return;
    }
    const rows = await db
      .select()
      .from(companySkills)
      .where(
        and(
          or(
            eq(companySkills.companyId, companyId),
            isNull(companySkills.companyId),
          ),
          inArray(companySkills.key, profileRow.desiredSkills),
        ),
      );
    // Return in desiredSkills order for deterministic preambles.
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const ordered = profileRow.desiredSkills
      .map((k) => byKey.get(k))
      .filter((r): r is (typeof rows)[number] => r != null)
      .map(toSkillDTO);
    res.json({ skills: ordered });
  },
);

// GET /api/me/agent/tools — list active tools the calling agent is
// allowed to use. Filter chain (mirrors skills semantics):
//   1. tool.status == 'active' (operator gate; paused/failed hidden)
//   2. tool.id is in the agent's enabled_tools (per-agent toggle)
//   3. tool.allowed_roles empty OR includes the agent's deployment role
// Re-fetched on each wake so flag changes propagate without redeploy.
router.get(
  "/agent/tools",
  requireAgentToken,
  async (req: Request, res: Response) => {
    const { companyId, agentId: deploymentId } = req.agent!;

    const [deploymentRow] = await db
      .select({
        role: deployments.role,
        enabledTools: agentRuntimeProfile.enabledTools,
      })
      .from(deployments)
      .innerJoin(
        agentRuntimeProfile,
        eq(agentRuntimeProfile.deploymentId, deployments.id),
      )
      .where(eq(deployments.id, deploymentId))
      .limit(1);
    if (!deploymentRow) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const enabledSet = new Set(deploymentRow.enabledTools);

    const rows = await db
      .select({
        id: companyTools.id,
        type: companyTools.type,
        label: companyTools.label,
        status: companyTools.status,
        allowedRoles: companyTools.allowedRoles,
      })
      .from(companyTools)
      .where(eq(companyTools.companyId, companyId));

    const catalog = await listCatalog();
    const catalogByType = new Map(catalog.map((e) => [e.type, e]));

    const tools: AgentToolDTO[] = rows
      .filter((r) => r.status === "active")
      .filter((r) => enabledSet.has(r.id))
      .filter((r) => {
        const allowed = r.allowedRoles ?? [];
        return allowed.length === 0 || allowed.includes(deploymentRow.role);
      })
      .map((r) => {
        const entry = catalogByType.get(r.type);
        return {
          id: r.id,
          type: r.type,
          label: r.label,
          displayName: entry?.displayName ?? r.type,
          status: r.status as AgentToolDTO["status"],
          // Static actions only for v1. MCP-backed tools with dynamic
          // actions would need a live tools/list call; deferring that
          // optimization until a real MCP entry lands.
          actions: entry?.actions ?? [],
        };
      });

    const body: ListAgentToolsResponse = { tools };
    res.json(body);
  },
);

// Agent-facing documents API. Mirrors the user-facing endpoint at
// /api/documents but authenticates via the per-trace API key and scopes
// reads to the calling agent's company. Documents are the company's
// shared episodic memory — every agent can fetch any company doc
// (no per-agent ACL today; if that's ever needed it lives here).
//
// Snippets are intentionally not truncated server-side; the agent
// asks for one doc at a time and gets the full content.

interface AgentDocumentDTO {
  id: string;
  taskId: string | null;
  deploymentId: string | null;
  title: string;
  format: string;
  tags: string[];
  createdAt: string;
}

interface AgentDocumentFullDTO extends AgentDocumentDTO {
  content: string;
}

function toAgentDocumentListItem(row: DocumentRow): AgentDocumentDTO {
  return {
    id: row.id,
    taskId: row.taskId,
    deploymentId: row.deploymentId,
    title: row.title,
    format: row.format,
    tags: row.tags,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAgentDocumentFull(row: DocumentRow): AgentDocumentFullDTO {
  return { ...toAgentDocumentListItem(row), content: row.content };
}

const AGENT_DOCS_DEFAULT_LIMIT = 25;
const AGENT_DOCS_MAX_LIMIT = 100;

// GET /api/me/agent/documents?tags=foo,bar&limit=25
// List documents in the agent's company, recency-ordered. ?tags filters
// to docs whose tags overlap any of the comma-separated values.
router.get(
  "/agent/documents",
  requireAgentToken,
  async (req: Request, res: Response) => {
    const { companyId } = req.agent!;

    const limitRaw = Number(req.query.limit ?? AGENT_DOCS_DEFAULT_LIMIT);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), AGENT_DOCS_MAX_LIMIT)
        : AGENT_DOCS_DEFAULT_LIMIT;

    const tagsParam =
      typeof req.query.tags === "string" ? req.query.tags : "";
    const tags = tagsParam
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const rows =
      tags.length > 0
        ? await listDocumentsByAnyTag({ companyId, tags, limit })
        : await listRecentDocuments({ companyId, limit });

    res.json({ documents: rows.map(toAgentDocumentListItem) });
  },
);

// GET /api/me/agent/documents/:id
// Full document content. Returns 404 if the doc belongs to another
// company (or doesn't exist).
router.get(
  "/agent/documents/:id",
  requireAgentToken,
  async (req: Request, res: Response) => {
    const { companyId } = req.agent!;
    const row = await findDocumentById({ companyId, id: req.params.id });
    if (!row) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    res.json({ document: toAgentDocumentFull(row) });
  },
);

// GET /api/me/agent/skills/:skillKey/files/*
// `:skillKey` must be URL-encoded ("owner%2Frepo%2Fslug"). The path after
// /files/ is the relative path inside the skill directory; must exist in
// fileInventory. Streams from raw.githubusercontent.com pinned to sourceRef.
router.get(
  "/agent/skills/:skillKey/files/*",
  requireAgentToken,
  async (req: Request, res: Response) => {
    const { agentId: deploymentId, companyId } = req.agent!;
    const skillKey = decodeURIComponent(req.params.skillKey);
    const requestedPath = (req.params as unknown as { 0?: string })[0] ?? "";
    if (!requestedPath) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.MISSING_PATH });
      return;
    }

    // Deployment must have the skill in its desiredSkills.
    const [profileRow] = await db
      .select({ desiredSkills: agentRuntimeProfile.desiredSkills })
      .from(agentRuntimeProfile)
      .where(eq(agentRuntimeProfile.deploymentId, deploymentId))
      .limit(1);
    if (!profileRow || !profileRow.desiredSkills.includes(skillKey)) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.SKILL_NOT_ASSIGNED });
      return;
    }

    const [skillRow] = await db
      .select()
      .from(companySkills)
      .where(
        and(
          or(
            eq(companySkills.companyId, companyId),
            isNull(companySkills.companyId),
          ),
          eq(companySkills.key, skillKey),
        ),
      )
      .limit(1);
    if (!skillRow) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.SKILL_NOT_FOUND });
      return;
    }

    const inventory = (skillRow.fileInventory as SkillFileEntry[]) ?? [];
    if (!inventory.some((e) => e.path === requestedPath)) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.FILE_NOT_IN_INVENTORY });
      return;
    }

    const rawUrl = `https://raw.githubusercontent.com/${skillRow.sourceOwner}/${skillRow.sourceRepo}/${skillRow.sourceRef}/${skillRow.sourcePath}/${requestedPath}`;
    const upstream = await fetch(rawUrl);
    if (!upstream.ok) {
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.UPSTREAM_FAILED, status: upstream.status });
      return;
    }
    const contentType =
      upstream.headers.get("Content-Type") ?? "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  },
);

export default router;
