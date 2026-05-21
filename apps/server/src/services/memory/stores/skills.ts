// Skills store — loads the assigned skill roster for a deployment with
// full markdown content so the renderer can inline it in the prompt. A
// memory TYPE; the assembler decides cadence (today: refreshed each
// call — the query is small and we want operator edits to land on the
// next wake without a cache flush).
//
// Source of truth: `agent_runtime_profile.desired_skills` lists keys
// scoped to the agent's company. We resolve each key against
// `company_skills` (visibility: companyId match OR builtin where
// companyId IS NULL) and preserve list order so renderer output is
// deterministic across runs.

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  agentRuntimeProfile,
  companySkills,
} from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import type { ContextSkill } from "../spec";

export async function loadSkills(args: {
  deploymentId: string;
  companyId: string;
}): Promise<ContextSkill[]> {
  const [profile] = await db
    .select({ desiredSkills: agentRuntimeProfile.desiredSkills })
    .from(agentRuntimeProfile)
    .where(eq(agentRuntimeProfile.deploymentId, args.deploymentId))
    .limit(1);
  const desired = profile?.desiredSkills ?? [];
  if (desired.length === 0) return [];

  const rows = await db
    .select({
      key: companySkills.key,
      slug: companySkills.slug,
      name: companySkills.name,
      description: companySkills.description,
      markdown: companySkills.markdown,
    })
    .from(companySkills)
    .where(
      and(
        or(
          eq(companySkills.companyId, args.companyId),
          isNull(companySkills.companyId),
        ),
        inArray(companySkills.key, desired),
      ),
    );

  const byKey = new Map(rows.map((r) => [r.key, r]));
  return desired
    .map((k) => byKey.get(k))
    .filter((r): r is NonNullable<typeof r> => r != null);
}
