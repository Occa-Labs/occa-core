// Company profile repo — 1:1 sibling of `companies` for brand / contact /
// crypto / audience metadata. Always upsert via `upsert(companyId, patch)`;
// the row is created lazily on first profile write so legacy companies
// don't need a backfill row up front.

import { eq, sql } from "drizzle-orm";
import { companyProfile } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type CompanyProfileRow = typeof companyProfile.$inferSelect;
export type CompanyProfileInsert = typeof companyProfile.$inferInsert;

export async function findByCompanyId(
  companyId: string,
): Promise<CompanyProfileRow | null> {
  const [row] = await db
    .select()
    .from(companyProfile)
    .where(eq(companyProfile.companyId, companyId))
    .limit(1);
  return row ?? null;
}

// Patch a subset of profile fields. Creates the row on first write
// (PG ON CONFLICT). Returns the fresh row — caller can hand straight to
// the DTO mapper.
export async function upsert(args: {
  companyId: string;
  patch: Omit<Partial<CompanyProfileInsert>, "companyId" | "createdAt" | "updatedAt">;
}): Promise<CompanyProfileRow> {
  const now = new Date();
  // Empty patch shouldn't write — skip the round-trip and just read back
  // (or return null; callers typically only invoke this when there's data).
  const hasPatch = Object.keys(args.patch).length > 0;
  if (!hasPatch) {
    const existing = await findByCompanyId(args.companyId);
    if (existing) return existing;
  }
  const [row] = await db
    .insert(companyProfile)
    .values({
      companyId: args.companyId,
      ...args.patch,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: companyProfile.companyId,
      set: { ...args.patch, updatedAt: now },
    })
    .returning();
  return row;
}

// Used by the company DELETE flow — cascade is set on the FK so this is
// rarely needed, but exposing it keeps the repo symmetric.
export async function deleteByCompanyId(companyId: string): Promise<void> {
  await db
    .delete(companyProfile)
    .where(eq(companyProfile.companyId, companyId));
}

// Re-export the SQL helper so consumers don't need to import drizzle-orm
// just to write `sql` defaults inside profile patches.
export { sql };
