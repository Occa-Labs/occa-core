// Identity store — the agent's stable sense of self: who it is, and the
// company it serves. This is a memory TYPE, not a load cadence; the
// assembler (`load-context.ts`) decides when it enters a prompt (today:
// every turn, since identity is cheap and always relevant).

import { eq } from "drizzle-orm";
import { getTier, roleLabelFor } from "@occa/shared/role-catalog";
import {
  agentIdentities,
  companies,
  companyProfile,
  deployments,
} from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import type {
  ContextAgent,
  ContextCompany,
  ContextCompanyProfile,
} from "../spec";

export class ContextNotFoundError extends Error {
  constructor(deploymentId: string) {
    super(`No deployment found for id ${deploymentId}`);
    this.name = "ContextNotFoundError";
  }
}

const EMPTY_PROFILE: ContextCompanyProfile = {
  tagline: null,
  niche: null,
  brandVoice: null,
  contentPillars: [],
  forbiddenWords: [],
  coverageScope: null,
  coverageExcluded: null,
};

export interface IdentityRecord {
  agent: ContextAgent;
  company: ContextCompany;
}

// Loads agent identity + company core for a deployment. One JOIN gets the
// identity row; a second optional query pulls the 1:1 company_profile
// sibling (may be missing when onboarding left it blank).
export async function loadIdentity(
  deploymentId: string,
): Promise<IdentityRecord> {
  const [head] = await db
    .select({
      agentName: agentIdentities.name,
      agentRole: deployments.role,
      companyId: deployments.companyId,
      companyName: companies.name,
    })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .innerJoin(companies, eq(deployments.companyId, companies.id))
    .where(eq(deployments.id, deploymentId))
    .limit(1);

  if (!head) throw new ContextNotFoundError(deploymentId);

  const [profileRow] = await db
    .select({
      tagline: companyProfile.tagline,
      niche: companyProfile.niche,
      brandVoice: companyProfile.brandVoice,
      contentPillars: companyProfile.contentPillars,
      forbiddenWords: companyProfile.forbiddenWords,
      coverageScope: companyProfile.coverageScope,
      coverageExcluded: companyProfile.coverageExcluded,
    })
    .from(companyProfile)
    .where(eq(companyProfile.companyId, head.companyId!))
    .limit(1);

  const profile: ContextCompanyProfile = profileRow
    ? {
        tagline: profileRow.tagline,
        niche: profileRow.niche,
        brandVoice: profileRow.brandVoice,
        contentPillars: profileRow.contentPillars ?? [],
        forbiddenWords: profileRow.forbiddenWords ?? [],
        coverageScope: profileRow.coverageScope,
        coverageExcluded: profileRow.coverageExcluded,
      }
    : EMPTY_PROFILE;

  const agent: ContextAgent = {
    id: deploymentId,
    name: head.agentName,
    role: head.agentRole,
    roleLabel: roleLabelFor(head.agentRole),
    tier: getTier(head.agentRole) ?? "unknown",
  };
  const company: ContextCompany = {
    id: head.companyId!,
    name: head.companyName,
    profile,
  };

  return { agent, company };
}
