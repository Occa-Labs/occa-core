// Trace tool-usage lookup for the verification gate.
//
// The gate bridge uses this to catch a specific leak: a deliverable
// that ships no <!--occa:claims--> block yet was produced by a run that
// called the DefiLlama data tools — on-chain numbers that escaped
// verification. Tool calls are persisted as `stream` trace events with
// a `{ kind: "tool", name }` payload.

import { and, eq, sql } from "drizzle-orm";
import { traceEvents } from "@occa/shared/schema";
import { db } from "../../../../infra/database/client";

const DEFILLAMA_TOOL_PREFIX = "defillama__";

// True when the trace called at least one DefiLlama data tool.
export async function traceUsedDefillamaTool(
  traceId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: traceEvents.id })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.traceId, traceId),
        eq(traceEvents.eventType, "stream"),
        sql`${traceEvents.payload} ->> 'kind' = 'tool'`,
        sql`${traceEvents.payload} ->> 'name' LIKE ${`${DEFILLAMA_TOOL_PREFIX}%`}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}
