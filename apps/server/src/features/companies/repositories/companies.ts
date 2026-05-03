// Companies repo — core lifecycle row (id, owner, name, kind, paused/kickoff
// state). Profile/brand/contact/crypto metadata lives in `company_profile`,
// loaded via `company-profiles.ts`. Use `findByIdWithProfile` /
// `findActiveOwnerCompanyWithProfile` when the caller needs the full DTO.

import { and, eq, isNull } from "drizzle-orm";
import { companies, companyProfile } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type CompanyRow = typeof companies.$inferSelect;
export type CompanyProfileRow = typeof companyProfile.$inferSelect;

export interface CompanyWithProfile {
  company: CompanyRow;
  profile: CompanyProfileRow | null;
}

export async function findById(companyId: string): Promise<CompanyRow | null> {
  const [row] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return row ?? null;
}

// Owner-scoped + soft-delete-aware load. Returns null if the row is owned by
// a different user or already soft-deleted.
export async function findOwnedById(args: {
  userId: string;
  companyId: string;
}): Promise<CompanyRow | null> {
  const [row] = await db
    .select()
    .from(companies)
    .where(
      and(
        eq(companies.id, args.companyId),
        eq(companies.ownerUserId, args.userId),
        isNull(companies.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

// The single active 'user'-kind company per owner (MVP one-wallet-one-company
// invariant). Returns null before onboarding completes.
export async function findActiveOwnerCompany(
  userId: string,
): Promise<CompanyRow | null> {
  const [row] = await db
    .select()
    .from(companies)
    .where(
      and(
        eq(companies.ownerUserId, userId),
        eq(companies.kind, "user"),
        isNull(companies.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

// LEFT JOIN convenience reads — return both rows for DTO mapping. Profile
// can be null for legacy companies created before the split (or before any
// profile fields were filled in).
export async function findByIdWithProfile(
  companyId: string,
): Promise<CompanyWithProfile | null> {
  const company = await findById(companyId);
  if (!company) return null;
  const [profile] = await db
    .select()
    .from(companyProfile)
    .where(eq(companyProfile.companyId, companyId))
    .limit(1);
  return { company, profile: profile ?? null };
}

export async function findOwnedByIdWithProfile(args: {
  userId: string;
  companyId: string;
}): Promise<CompanyWithProfile | null> {
  const company = await findOwnedById(args);
  if (!company) return null;
  const [profile] = await db
    .select()
    .from(companyProfile)
    .where(eq(companyProfile.companyId, company.id))
    .limit(1);
  return { company, profile: profile ?? null };
}

export async function findActiveOwnerCompanyWithProfile(
  userId: string,
): Promise<CompanyWithProfile | null> {
  const company = await findActiveOwnerCompany(userId);
  if (!company) return null;
  const [profile] = await db
    .select()
    .from(companyProfile)
    .where(eq(companyProfile.companyId, company.id))
    .limit(1);
  return { company, profile: profile ?? null };
}

// Patch core lifecycle fields (name, paused state, kickoff state). Caller
// supplies a partial; we always bump updated_at. Returns the fresh row.
export async function updateCore(args: {
  companyId: string;
  patch: Partial<typeof companies.$inferInsert>;
}): Promise<CompanyRow> {
  const [row] = await db
    .update(companies)
    .set({ ...args.patch, updatedAt: new Date() })
    .where(eq(companies.id, args.companyId))
    .returning();
  return row;
}
