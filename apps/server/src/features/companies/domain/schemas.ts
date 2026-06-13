// Zod schemas for company HTTP body validation.
// Lives in domain/ because validation is pure logic — no Drizzle, no Express.

import { z } from "zod";
import type {
  PauseCompanyRequest,
  UpdateCompanyRequest,
} from "@occa/shared/types";
import { LIMITS } from "../../../lib/limits";

// Trim + reject whitespace-only strings. `null` clears, missing leaves alone.
export const nullableText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .transform((v) => (typeof v === "string" && v.length === 0 ? null : v))
    .optional();

export const optionalArray = (max: number) =>
  z.array(z.string().trim().min(1).max(max)).optional();

// Onboarding step 1 — single-field company creation. The rest of the
// profile (tagline, niche, etc.) is captured later via PATCH /api/companies.
export const createCompanyBody = z.object({
  name: z.string().trim().min(1).max(LIMITS.NAME),
});

export const updateCompanyBody = z.object({
  name: z.string().trim().min(1).max(LIMITS.NAME).optional(),
  tagline: nullableText(160),
  logoUrl: nullableText(500),
  niche: nullableText(120),
  foundedAt: z
    .union([z.string().regex(/^\d{4}-\d{2}-\d{2}/), z.null()])
    .optional(),
  coverageScope: nullableText(2_000),
  coverageExcluded: nullableText(2_000),
  contentPillars: optionalArray(120),
  brandVoice: nullableText(2_000),
  forbiddenWords: optionalArray(80),
  mission: nullableText(2_000),
  vision: nullableText(2_000),
  targetAudience: nullableText(1_000),
  usps: optionalArray(200),
  coreOffering: nullableText(1_000),
  serviceCatalog: optionalArray(120),
  contactEmail: nullableText(200),
  salesEmail: nullableText(200),
  phone: nullableText(40),
  websiteUrl: nullableText(500),
  blogUrl: nullableText(500),
  newsletterUrl: nullableText(500),
  docsUrl: nullableText(500),
  socialHandles: z
    .record(z.string(), z.string().trim().max(LIMITS.TITLE))
    .optional(),
  treasuryAddress: nullableText(200),
  chainsCovered: optionalArray(80),
  monthlyBudgetCents: z
    .number()
    .int()
    .min(LIMITS.MONTHLY_BUDGET_CENTS_MIN)
    .max(LIMITS.MONTHLY_BUDGET_CENTS_MAX)
    .optional(),
}) satisfies z.ZodType<UpdateCompanyRequest>;

export const pauseCompanyBody = z.object({
  reason: nullableText(500),
}) satisfies z.ZodType<PauseCompanyRequest>;
