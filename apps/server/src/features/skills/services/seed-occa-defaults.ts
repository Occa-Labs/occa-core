// Boot-time seed for OCCA platform default skills only (e.g.
// `agent-protocol`). Per-role skills are NOT seeded here — they're
// fetched lazily when agents are provisioned. See
// services/agent-skill-assign.ts for the lazy flow.
//
// Idempotent: re-running on every boot is fine because
// `ensureCompanySkill` upserts via onConflictDoNothing.

import {
  OCCA_DEFAULT_SKILLS,
  ensureCompanySkill,
} from "./agent-skill-assign";
import { childLogger } from "../../../lib/logger";

const log = childLogger("seed");

export async function seedOccaDefaultSkills(): Promise<void> {
  let ok = 0;
  let failed = 0;
  for (const source of OCCA_DEFAULT_SKILLS) {
    try {
      await ensureCompanySkill(source);
      ok++;
    } catch (err) {
      failed++;
      log.warn({ err, source }, "failed to seed OCCA default skill");
    }
  }
  log.info({ ok, failed }, "OCCA default skills ensured");
}
