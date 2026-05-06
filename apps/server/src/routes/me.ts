import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "../infra/database/client";
import {
  agentRuntimeProfile,
  companySkills,
  deployments,
  users,
} from "@occa/shared/schema";
import {
  type AgentRole,
  type MeResponse,
  type SkillDTO,
  type SkillFileEntry,
  type SkillSourceType,
} from "@occa/shared/types";
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
