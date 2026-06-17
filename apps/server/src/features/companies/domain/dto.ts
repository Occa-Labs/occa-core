// Single source of truth for `CompanyDTO` mapping. Profile fields live in
// the sibling `company_profile` table (split from companies for parent-row
// hygiene); pass the joined row pair so the DTO stays whole. Profile may be
// null for companies created before any profile field was set — emit
// schema-default values in that case so the client contract stays stable.

import type { CompanyDTO } from "@occa/shared/types";
import type { CompanyRow, CompanyProfileRow } from "../repositories/companies";

export function toCompanyDTO(
  company: CompanyRow,
  profile: CompanyProfileRow | null,
): CompanyDTO {
  return {
    id: company.id,
    name: company.name,
    kind: company.kind as CompanyDTO["kind"],
    createdAt: company.createdAt.toISOString(),

    tagline: profile?.tagline ?? null,
    logoUrl: profile?.logoUrl ?? null,
    niche: profile?.niche ?? null,
    foundedAt: profile?.foundedAt ?? null,

    coverageScope: profile?.coverageScope ?? null,
    coverageExcluded: profile?.coverageExcluded ?? null,
    contentPillars: profile?.contentPillars ?? [],
    brandVoice: profile?.brandVoice ?? null,
    forbiddenWords: profile?.forbiddenWords ?? [],

    mission: profile?.mission ?? null,
    vision: profile?.vision ?? null,
    targetAudience: profile?.targetAudience ?? null,
    usps: profile?.usps ?? [],

    coreOffering: profile?.coreOffering ?? null,
    serviceCatalog: profile?.serviceCatalog ?? [],

    contactEmail: profile?.contactEmail ?? null,
    salesEmail: profile?.salesEmail ?? null,
    phone: profile?.phone ?? null,

    websiteUrl: profile?.websiteUrl ?? null,
    blogUrl: profile?.blogUrl ?? null,
    newsletterUrl: profile?.newsletterUrl ?? null,
    docsUrl: profile?.docsUrl ?? null,
    socialHandles:
      (profile?.socialHandles as Record<string, string> | null) ?? {},

    treasuryAddress: profile?.treasuryAddress ?? null,
    chainsCovered: profile?.chainsCovered ?? [],

    monthlyBudgetCents: company.monthlyBudgetCents,
    maxReviewRounds: company.maxReviewRounds,
    researchBudget: company.researchBudget,

    pausedAt: company.pausedAt ? company.pausedAt.toISOString() : null,
    pausedReason: company.pausedReason,

    kickoffState: company.kickoffState as CompanyDTO["kickoffState"],
    kickoffStartedAt: company.kickoffStartedAt
      ? company.kickoffStartedAt.toISOString()
      : null,
    kickoffCompletedAt: company.kickoffCompletedAt
      ? company.kickoffCompletedAt.toISOString()
      : null,

    companyPda: company.companyPda ?? null,
    ownerWallet: company.ownerWallet ?? null,
    chainNonce: company.chainNonce ?? null,
    chainTxSignature: company.chainTxSignature ?? null,
  };
}
