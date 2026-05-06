// Skill-sync surface for a single deployment — list current sync state +
// derive UI status (outdated / skill_deleted), commit a new desired-skill
// list, force a single skill to resync. Workspace-template skills are
// pushed by the worker via `skill-sync.ts`; these endpoints just manage
// the desired state + the per-skill sync rows.

import { Router, type Request, type Response } from "express";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import {
  agentRuntimeProfile,
  companySkills,
  deploymentSkillSyncs,
} from "@occa/shared/schema";
import type {
  AgentSkillSyncDTO,
  AgentSkillSyncStatus,
  ListAgentSkillSyncsResponse,
} from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import { findOwnedByUserId } from "../repositories/deployments";
import { findByDeploymentId as findRuntimeProfile } from "../repositories/agent-runtime-profile";
import { requireAuth } from "../../../middleware/auth";
import {
  resyncSkillBody,
  syncSkillsBody,
} from "../domain/schemas";
import { toSkillSyncDTO } from "../domain/dtos";
import { hydrateDeploymentDTO } from "../services/deployment-status";

const router: Router = Router();

// GET /api/agents/:id/skills/syncs — list sync rows with derived status.
router.get(
  "/:id/skills/syncs",
  requireAuth,
  async (req: Request, res: Response) => {
    const existing = await findOwnedByUserId({
      userId: req.user!.userId,
      deploymentId: req.params.id,
    });
    if (!existing) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const profile = await findRuntimeProfile(existing.id);
    if (!profile) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }

    let syncRows = await db
      .select()
      .from(deploymentSkillSyncs)
      .where(eq(deploymentSkillSyncs.deploymentId, existing.id));

    // Backfill: create pending install rows for any desiredSkills that have
    // no sync row yet (covers deployments assigned skills before the sync
    // system landed).
    const syncedKeys = new Set(syncRows.map((r) => r.skillKey));
    const missing = profile.desiredSkills.filter((k) => !syncedKeys.has(k));
    if (missing.length > 0) {
      const inserted = await db
        .insert(deploymentSkillSyncs)
        .values(
          missing.map((key) => ({
            deploymentId: existing.id,
            companyId: existing.companyId,
            skillKey: key,
            status: "pending" as const,
            action: "install" as const,
          })),
        )
        .onConflictDoNothing()
        .returning();
      syncRows = [...syncRows, ...inserted];
    }

    if (syncRows.length === 0) {
      const body: ListAgentSkillSyncsResponse = { syncs: [] };
      res.json(body);
      return;
    }

    // Fetch the current library snapshot for all skill keys to derive
    // "outdated" and "skill_deleted" statuses at query time.
    const skillKeys = syncRows.map((r) => r.skillKey);
    const libRows = await db
      .select({ key: companySkills.key, sourceRef: companySkills.sourceRef })
      .from(companySkills)
      .where(
        and(
          or(
            eq(companySkills.companyId, existing.companyId),
            isNull(companySkills.companyId),
          ),
          inArray(companySkills.key, skillKeys),
        ),
      );
    const libMap = new Map(libRows.map((r) => [r.key, r.sourceRef]));

    const syncs: AgentSkillSyncDTO[] = syncRows.map((row) => {
      let derived: AgentSkillSyncStatus | undefined;
      if (row.status === "installed") {
        if (!libMap.has(row.skillKey)) {
          derived = "skill_deleted";
        } else if (
          row.skillRef &&
          libMap.get(row.skillKey) !== row.skillRef
        ) {
          derived = "outdated";
        }
      }
      return toSkillSyncDTO(row, derived);
    });

    const body: ListAgentSkillSyncsResponse = { syncs };
    res.json(body);
  },
);

// POST /api/agents/:id/skills/sync — replace desired_skills set.
// Inserts pending install rows for added skills, queues uninstall for
// removed ones (only if they were successfully installed; pending/failed
// removed entries are deleted outright).
router.post(
  "/:id/skills/sync",
  requireAuth,
  async (req: Request, res: Response) => {
    const existing = await findOwnedByUserId({
      userId: req.user!.userId,
      deploymentId: req.params.id,
    });
    if (!existing) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const profile = await findRuntimeProfile(existing.id);
    if (!profile) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const parsed = syncSkillsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.INVALID_BODY,
        detail: parsed.error.flatten(),
      });
      return;
    }
    const dedup = Array.from(new Set(parsed.data.desiredSkills));

    // Validate: every requested key must exist in this company's skill
    // library. Also enforce per-skill role gating (allowedRoles).
    if (dedup.length > 0) {
      const known = await db
        .select({
          key: companySkills.key,
          allowedRoles: companySkills.allowedRoles,
        })
        .from(companySkills)
        .where(
          and(
            or(
              eq(companySkills.companyId, existing.companyId),
              isNull(companySkills.companyId),
            ),
            inArray(companySkills.key, dedup),
          ),
        );
      const knownMap = new Map(known.map((r) => [r.key, r.allowedRoles]));
      const unknown = dedup.filter((k) => !knownMap.has(k));
      if (unknown.length > 0) {
        res.status(StatusCodes.BAD_REQUEST).json({
          error: ERROR_CODES.UNKNOWN_SKILL_KEYS,
          keys: unknown,
        });
        return;
      }
      const disallowed = dedup.filter((k) => {
        const roles = knownMap.get(k) ?? [];
        return roles.length > 0 && !roles.includes(existing.role);
      });
      if (disallowed.length > 0) {
        res.status(StatusCodes.BAD_REQUEST).json({
          error: ERROR_CODES.ROLE_NOT_ALLOWED,
          agentRole: existing.role,
          keys: disallowed,
        });
        return;
      }
    }

    await db
      .update(agentRuntimeProfile)
      .set({ desiredSkills: dedup, updatedAt: new Date() })
      .where(eq(agentRuntimeProfile.deploymentId, existing.id));

    // Manage sync rows: insert pending rows for newly added skills, queue
    // uninstall for removed ones. Upserts so re-adding a failed/installed
    // skill resets cleanly without duplicate rows.
    const prevSkills = new Set(profile.desiredSkills);
    const nextSkills = new Set(dedup);

    const added = dedup.filter((k) => !prevSkills.has(k));
    const removed = profile.desiredSkills.filter((k) => !nextSkills.has(k));

    if (added.length > 0) {
      await db
        .insert(deploymentSkillSyncs)
        .values(
          added.map((key) => ({
            deploymentId: existing.id,
            companyId: existing.companyId,
            skillKey: key,
            status: "pending" as const,
            action: "install" as const,
          })),
        )
        .onConflictDoUpdate({
          target: [
            deploymentSkillSyncs.deploymentId,
            deploymentSkillSyncs.skillKey,
          ],
          set: {
            status: "pending",
            action: "install",
            lastError: null,
            updatedAt: sql`now()`,
          },
        });
    }

    if (removed.length > 0) {
      // Only queue uninstall for rows that were successfully installed.
      // Pending/failed rows for removed skills can just be deleted.
      await db
        .delete(deploymentSkillSyncs)
        .where(
          and(
            eq(deploymentSkillSyncs.deploymentId, existing.id),
            inArray(deploymentSkillSyncs.skillKey, removed),
            inArray(deploymentSkillSyncs.status, ["pending", "failed"]),
          ),
        );
      await db
        .insert(deploymentSkillSyncs)
        .values(
          removed.map((key) => ({
            deploymentId: existing.id,
            companyId: existing.companyId,
            skillKey: key,
            status: "pending" as const,
            action: "uninstall" as const,
          })),
        )
        .onConflictDoUpdate({
          target: [
            deploymentSkillSyncs.deploymentId,
            deploymentSkillSyncs.skillKey,
          ],
          set: {
            status: "pending",
            action: "uninstall",
            lastError: null,
            updatedAt: sql`now()`,
          },
        });
    }

    res.json({ agent: await hydrateDeploymentDTO(existing) });
  },
);

// POST /api/agents/:id/skills/:key/resync — reset a sync row to pending so
// the worker picks it up again. Handles: failed retry, outdated reinstall,
// skill_deleted uninstall confirmation, or manual force-reinstall.
router.post(
  "/:id/skills/:key/resync",
  requireAuth,
  async (req: Request, res: Response) => {
    const existing = await findOwnedByUserId({
      userId: req.user!.userId,
      deploymentId: req.params.id,
    });
    if (!existing) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    const profile = await findRuntimeProfile(existing.id);
    if (!profile) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }

    const parsed = resyncSkillBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.INVALID_BODY,
        detail: parsed.error.flatten(),
      });
      return;
    }

    // key is URL-encoded "owner/repo/slug" — Express param encodes the
    // slashes so we need to decode it.
    const skillKey = decodeURIComponent(req.params.key);
    const action = parsed.data.action ?? "reinstall";

    const [syncRow] = await db
      .select()
      .from(deploymentSkillSyncs)
      .where(
        and(
          eq(deploymentSkillSyncs.deploymentId, existing.id),
          eq(deploymentSkillSyncs.skillKey, skillKey),
        ),
      )
      .limit(1);

    if (!syncRow) {
      // Row doesn't exist yet — insert as pending install if skill is
      // desired.
      if (!profile.desiredSkills.includes(skillKey)) {
        res
          .status(StatusCodes.NOT_FOUND)
          .json({ error: ERROR_CODES.SKILL_NOT_ASSIGNED });
        return;
      }
      const [inserted] = await db
        .insert(deploymentSkillSyncs)
        .values({
          deploymentId: existing.id,
          companyId: existing.companyId,
          skillKey,
          status: "pending",
          action: action === "uninstall" ? "uninstall" : "install",
        })
        .returning();
      res.json({ sync: toSkillSyncDTO(inserted) });
      return;
    }

    const [updated] = await db
      .update(deploymentSkillSyncs)
      .set({
        status: "pending",
        action,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(deploymentSkillSyncs.id, syncRow.id))
      .returning();
    res.json({ sync: toSkillSyncDTO(updated) });
  },
);

export default router;
