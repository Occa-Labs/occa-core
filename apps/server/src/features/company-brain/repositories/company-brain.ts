// Company Brain repository — Drizzle access for the `company_brain` table.
// See `packages/shared/src/schema.ts:companyBrain` for table rationale.

import { and, asc, eq } from "drizzle-orm";
import { companyBrain } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type CompanyBrainRow = typeof companyBrain.$inferSelect;
export type CompanyBrainInsert = typeof companyBrain.$inferInsert;

export async function listForCompany(
  companyId: string,
): Promise<CompanyBrainRow[]> {
  return db
    .select()
    .from(companyBrain)
    .where(eq(companyBrain.companyId, companyId))
    .orderBy(asc(companyBrain.path));
}

export async function findByPath(args: {
  companyId: string;
  path: string;
}): Promise<CompanyBrainRow | undefined> {
  const [row] = await db
    .select()
    .from(companyBrain)
    .where(
      and(
        eq(companyBrain.companyId, args.companyId),
        eq(companyBrain.path, args.path),
      ),
    )
    .limit(1);
  return row;
}

export async function findById(args: {
  companyId: string;
  id: string;
}): Promise<CompanyBrainRow | undefined> {
  const [row] = await db
    .select()
    .from(companyBrain)
    .where(
      and(
        eq(companyBrain.companyId, args.companyId),
        eq(companyBrain.id, args.id),
      ),
    )
    .limit(1);
  return row;
}

export async function insertBrainFile(
  input: CompanyBrainInsert,
): Promise<CompanyBrainRow> {
  const [row] = await db.insert(companyBrain).values(input).returning();
  return row;
}

export interface UpdateBrainFileInput {
  content?: string;
  visibility?: string;
  updatedBy: string | null;
}

export async function updateBrainFileById(args: {
  companyId: string;
  id: string;
  updates: UpdateBrainFileInput;
}): Promise<CompanyBrainRow | undefined> {
  const [row] = await db
    .update(companyBrain)
    .set({
      ...(args.updates.content !== undefined
        ? { content: args.updates.content }
        : {}),
      ...(args.updates.visibility !== undefined
        ? { visibility: args.updates.visibility }
        : {}),
      updatedBy: args.updates.updatedBy,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(companyBrain.companyId, args.companyId),
        eq(companyBrain.id, args.id),
      ),
    )
    .returning();
  return row;
}

export async function deleteBrainFileById(args: {
  companyId: string;
  id: string;
}): Promise<boolean> {
  const rows = await db
    .delete(companyBrain)
    .where(
      and(
        eq(companyBrain.companyId, args.companyId),
        eq(companyBrain.id, args.id),
      ),
    )
    .returning({ id: companyBrain.id });
  return rows.length > 0;
}
