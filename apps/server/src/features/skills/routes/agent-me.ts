// Agent-facing skills API mounted at /api/me/agent/skills.
//
// Two routes:
//   GET /                        — list SkillDTO[] for the agent's desiredSkills
//   GET /:skillKey/files/*       — proxy a file from the skill's GitHub source
//
// Auth: per-trace agent token. Read scoped to the calling agent's
// deployment + company.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { agentRuntimeProfile, companySkills } from "@occa/shared/schema";
import {
  type AgentRole,
  type SkillDTO,
  type SkillFileEntry,
  type SkillSourceType,
} from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import { requireAgentToken } from "../../../middleware/agent-auth";

const router: Router = Router();

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
router.get("/", requireAgentToken, async (req: Request, res: Response) => {
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
});

// GET /api/me/agent/skills/:skillKey/files/*
// `:skillKey` must be URL-encoded ("owner%2Frepo%2Fslug"). The path after
// /files/ is the relative path inside the skill directory; must exist in
// fileInventory. Streams from raw.githubusercontent.com pinned to sourceRef.
router.get(
  "/:skillKey/files/*",
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
