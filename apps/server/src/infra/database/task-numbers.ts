// Per-company monotonically-increasing task number allocator. Lives in
// infra/database/ so both features/tasks (user-create) and features/
// agents (EmitFollowUp) and routes/approvals (delegate-spawn) can share
// it without crossing feature boundaries.
//
// Callers MUST run this inside a transaction that has taken a row-level
// lock on the company (or otherwise serialised their own writes against
// the unique (company_id, task_number) index). Without serialisation,
// concurrent calls compute the same `next` and the second insert hits
// 23505. The transaction wrapper in callers is the right home for the
// row lock; this helper just runs the SELECT.

import { sql } from "drizzle-orm";
import type { db as serverDb } from "./client";

type TxOrDb =
  | typeof serverDb
  | Parameters<Parameters<typeof serverDb.transaction>[0]>[0];

export async function nextTaskNumber(
  tx: TxOrDb,
  companyId: string,
): Promise<number> {
  const result = await tx.execute<{ max: number | null }>(sql`
    SELECT COALESCE(MAX(task_number), 0) AS max
    FROM tasks
    WHERE company_id = ${companyId}
  `);
  return (result.rows[0]?.max ?? 0) + 1;
}
