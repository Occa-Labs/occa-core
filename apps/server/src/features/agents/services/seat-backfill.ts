// One-shot backfill of `agents.workstation_id` for rows that pre-date the
// per-agent seat assignment migration (drizzle 0031). Idempotent — once
// every agent has a workstation, the SELECT returns no rows and this is a
// no-op. Runs at server boot so any environment restored from a pre-0031
// snapshot self-heals on first start.
//
// Why not lazy-backfill on read: multiple legacy agents at the same table
// would each call the seating algorithm with an empty `occupied` set, and
// every agent in the same zone would land on the first desk → visible
// collision in the 3D scene. Sequential boot-time backfill computes seats
// against the live occupied set so each legacy agent gets a unique desk.

import { and, asc, eq, isNull } from "drizzle-orm";
import { agents } from "@occa/shared/schema";
import { childLogger } from "../../../lib/logger";
import { db } from "../../../infra/database/client";
import { assignSeatForCompany } from "./seat-assignment";

const log = childLogger("seat-backfill");

export async function backfillAgentSeats(): Promise<void> {
  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      role: agents.role,
    })
    .from(agents)
    .where(isNull(agents.workstationId))
    .orderBy(asc(agents.companyId), asc(agents.createdAt));

  if (rows.length === 0) return;

  log.info({ count: rows.length }, "backfilling agent seats");

  let assigned = 0;
  let skipped = 0;
  for (const row of rows) {
    const seat = await assignSeatForCompany({
      companyId: row.companyId,
      role: row.role,
    });
    if (!seat) {
      skipped++;
      continue;
    }
    await db
      .update(agents)
      .set({ workstationId: seat, updatedAt: new Date() })
      .where(and(eq(agents.id, row.id), isNull(agents.workstationId)));
    assigned++;
  }

  log.info({ assigned, skipped }, "seat backfill done");
}
