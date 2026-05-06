// Seat assignment for newly deployed agents. Wraps the pure algorithm
// in `@occa/shared/seating` with a DB lookup of currently-occupied
// desks.
//
// Two callers:
//   1. deployment-create (one-shot deploy from the Deploy modal)
//   2. kickoff-service (bulk deploy during onboarding)
//
// `null` means the office is full (every assignable desk taken).
// Workstation now lives on `agent_runtime_profile`, scoped per company
// via the JOIN through `deployments`.

import { and, eq, isNotNull } from "drizzle-orm";
import { agentRuntimeProfile } from "@occa/shared/schema";
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
    .select({ workstationId: agentRuntimeProfile.workstationId })
    .from(agentRuntimeProfile)
    .where(
      and(
        eq(agentRuntimeProfile.companyId, companyId),
        isNotNull(agentRuntimeProfile.workstationId),
      ),
    );
  return new Set(
    rows.map((r) => r.workstationId).filter((v): v is string => v !== null),
  );
}
