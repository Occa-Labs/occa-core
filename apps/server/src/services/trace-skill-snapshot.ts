// Snapshot a deployment's current skill set into the shape stored on a
// trace's `skillsUsed` column. Captured at trace open so that future
// reputation (Phase 3) can attribute outcomes to the exact skill
// version that was loaded during execution.
//
// Lives in `services/` (legacy spine) because it bridges
// `features/skills` (data) and trace creation in `features/tasks` /
// `worker/wakeup` (consumers) — CLAUDE.md forbids feature-to-feature
// imports.
//
// Best-effort: any failure resolves to `[]` so trace open never blocks
// on this metadata. The trace stays openable; the snapshot is lost.

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  agentRuntimeProfile,
  companySkills,
} from "@occa/shared/schema";
import type { SkillUsageEntry } from "@occa/shared/types";
import { db } from "../infra/database/client";
import { childLogger } from "../lib/logger";

const log = childLogger("services:trace-skill-snapshot");

export async function snapshotDeploymentSkills(
  deploymentId: string,
  companyId: string,
): Promise<SkillUsageEntry[]> {
  try {
    const [profile] = await db
      .select({ desiredSkills: agentRuntimeProfile.desiredSkills })
      .from(agentRuntimeProfile)
      .where(eq(agentRuntimeProfile.deploymentId, deploymentId))
      .limit(1);
    if (!profile || profile.desiredSkills.length === 0) return [];

    const rows = await db
      .select({
        id: companySkills.id,
        key: companySkills.key,
        sourceRef: companySkills.sourceRef,
      })
      .from(companySkills)
      .where(
        and(
          or(
            eq(companySkills.companyId, companyId),
            isNull(companySkills.companyId),
          ),
          inArray(companySkills.key, profile.desiredSkills),
        ),
      );

    // Return in desiredSkills order so the snapshot reads like the
    // agent's roster, not whatever the DB returned.
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return profile.desiredSkills
      .map((k) => byKey.get(k))
      .filter((r): r is (typeof rows)[number] => r != null);
  } catch (err) {
    log.warn({ err, deploymentId }, "snapshot failed; trace opens with empty skillsUsed");
    return [];
  }
}
