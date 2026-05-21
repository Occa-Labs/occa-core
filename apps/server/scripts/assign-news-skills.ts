#!/usr/bin/env tsx
// Assigns the Glyph news-lane skills to existing News Writer agents.
//
// New news_writer deployments pick these up automatically from
// ROLE_DEFAULT_SKILLS in features/skills/domain/catalog.ts. This one-shot
// covers an agent provisioned before that catalog entry existed: it
// fetches + caches the skills, writes their keys into desiredSkills, and
// enqueues install syncs for the worker to push to the gateway.
//
// Idempotent — only newly added skill keys are enqueued.
//
// Usage (from apps/server/):
//   pnpm exec tsx --env-file=../../.env scripts/assign-news-skills.ts

import { eq } from "drizzle-orm";
import type { AgentRole } from "@occa/shared/types";
import { deployments } from "@occa/shared/schema";
import { db, pool } from "../src/infra/database/client";
import {
  autoAssignSkillsToNewAgent,
  enqueueSkillSyncs,
} from "../src/features/skills/services/agent-skill-assign";
import { getDesiredSkills } from "../src/features/agents/repositories/agent-runtime-profile";

const ROLE: AgentRole = "news_writer";

async function main(): Promise<void> {
  const newsWriters = await db
    .select({ id: deployments.id, companyId: deployments.companyId })
    .from(deployments)
    .where(eq(deployments.role, ROLE));

  if (newsWriters.length === 0) {
    console.error(`No deployment with role "${ROLE}".`);
    process.exit(1);
  }

  for (const dep of newsWriters) {
    const before = (await getDesiredSkills(dep.id)) ?? [];
    const resolved = await autoAssignSkillsToNewAgent(
      dep.id,
      ROLE,
      dep.companyId,
    );
    const added = resolved.filter((k) => !before.includes(k));
    if (added.length > 0) {
      await enqueueSkillSyncs({
        deploymentId: dep.id,
        companyId: dep.companyId,
        skillKeys: added,
      });
    }
    console.log(
      `${dep.id}: ${resolved.length} resolved, ${added.length} newly enqueued` +
        (added.length > 0 ? `\n  ${added.join("\n  ")}` : ""),
    );
  }
}

void main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
