// One-shot backfill of `agent_runtime_profile.workstation_id` for rows
// that pre-date the per-deployment seat assignment. Idempotent — once
// every runtime profile has a workstation, the SELECT returns no rows
// and this is a no-op. Runs at server boot so any environment restored
// from a pre-seat-column snapshot self-heals on first start.
//
// Why not lazy-backfill on read: multiple legacy deployments at the same
// table would each call the seating algorithm with an empty `occupied`
// set, and every row in the same zone would land on the first desk →
// visible collision in the 3D scene. Sequential boot-time backfill
// computes seats against the live occupied set so each legacy row gets
// a unique desk.

import { and, asc, eq, isNull } from "drizzle-orm";
import { agentRuntimeProfile, deployments } from "@occa/shared/schema";
import { childLogger } from "../../../lib/logger";
import { db } from "../../../infra/database/client";
import { assignSeatForCompany } from "./seat-assignment";

const log = childLogger("seat-backfill");

export async function backfillDeploymentSeats(): Promise<void> {
  const rows = await db
    .select({
      deploymentId: agentRuntimeProfile.deploymentId,
      companyId: agentRuntimeProfile.companyId,
      role: deployments.role,
    })
    .from(agentRuntimeProfile)
    .innerJoin(
      deployments,
      eq(agentRuntimeProfile.deploymentId, deployments.id),
    )
    .where(isNull(agentRuntimeProfile.workstationId))
    .orderBy(asc(agentRuntimeProfile.companyId), asc(deployments.createdAt));

  if (rows.length === 0) return;

  log.info({ count: rows.length }, "backfilling deployment seats");

  let assigned = 0;
  let skipped = 0;
  for (const row of rows) {
    // Idle agents (no company) have no office seat to backfill.
    if (!row.companyId) {
      skipped++;
      continue;
    }
    const seat = await assignSeatForCompany({
      companyId: row.companyId,
      role: row.role,
    });
    if (!seat) {
      skipped++;
      continue;
    }
    await db
      .update(agentRuntimeProfile)
      .set({ workstationId: seat, updatedAt: new Date() })
      .where(
        and(
          eq(agentRuntimeProfile.deploymentId, row.deploymentId),
          isNull(agentRuntimeProfile.workstationId),
        ),
      );
    assigned++;
  }

  log.info({ assigned, skipped }, "seat backfill done");
}
