// Seat assignment for newly hired agents. Wraps the pure algorithm in
// `@occa/shared/seating` with a DB lookup of currently-occupied desks.
//
// Two callers:
//   1. agent-create (one-shot hire from the Hire modal)
//   2. kickoff-service (bulk hire during onboarding) — calls per agent in
//      the same loop that inserts rows, so each call sees the prior hire
//      already occupying its desk.
//
// Returning `null` means the office is full (every assignable desk taken).
// Callers either propagate the error or fall back to a sentinel — current
// policy is to fail the hire so the user can free a seat first.

import { and, eq, isNotNull } from "drizzle-orm";
import { agents } from "@occa/shared/schema";
import { assignSeat as pureAssignSeat } from "@occa/shared/seating";
import type { AgentRole } from "@occa/shared/types";
import { db } from "../../../infra/database/client";

export async function assignSeatForCompany(args: {
  companyId: string;
  role: AgentRole;
}): Promise<string | null> {
  const occupied = await loadOccupiedDesks(args.companyId);
  return pureAssignSeat({ role: args.role, occupied });
}

async function loadOccupiedDesks(
  companyId: string,
): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ workstationId: agents.workstationId })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        isNotNull(agents.workstationId),
      ),
    );
  return new Set(
    rows.map((r) => r.workstationId).filter((v): v is string => v !== null),
  );
}
