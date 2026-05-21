// Structured claim block that a story doc must carry so its numbers can
// be machine-verified. The agent writes prose freely, then emits one
// `<!--occa:claims ... -->` block whose every numeric claim is a row the
// verifier can re-fetch and diff. Prose interpretation is NOT covered
// here — only quantitative claims with a checkable source.

import { z } from "zod";

// Claim ids are referenced from `expression` strings, so they must not
// contain the `+ - * /` arithmetic chars. Letters, digits, `_`, `.` only.
const claimId = z
  .string()
  .regex(/^[A-Za-z0-9_.]+$/, "claim id may only contain [A-Za-z0-9_.]");

// Shared tolerance fields. `abs_tolerance` wins when set (right for
// percentage-point fields like change_7dover7d, where a relative
// tolerance near zero misbehaves); otherwise `tolerance` is relative.
const toleranceFields = {
  tolerance: z.number().positive().optional(),
  abs_tolerance: z.number().positive().optional(),
};

// A claim sourced directly from a DefiLlama endpoint. `endpoint` is a
// path under api.llama.fi; `selector` walks the JSON to a single number.
const defillamaClaim = z.object({
  source: z.literal("defillama"),
  id: claimId,
  label: z.string().trim().min(1),
  endpoint: z.string().startsWith("/"),
  selector: z.string().trim().min(1),
  value: z.number(),
  ...toleranceFields,
});

// A claim the agent computed from other claims (e.g. a sum). The
// `expression` references other claim ids and numeric literals with
// `+ -` operators; the verifier recomputes it from verified inputs.
const calculatedClaim = z.object({
  source: z.literal("calculated"),
  id: claimId,
  label: z.string().trim().min(1),
  expression: z.string().trim().min(1),
  value: z.number(),
  ...toleranceFields,
});

export const claim = z.discriminatedUnion("source", [
  defillamaClaim,
  calculatedClaim,
]);

export const claimsBlock = z.object({
  // Date the data was retrieved. The verifier rejects any as_of in the
  // future relative to server time — this is what catches a hallucinated
  // date built from a mis-converted Unix timestamp.
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "as_of must be YYYY-MM-DD"),
  claims: z.array(claim).min(1),
});

export type Claim = z.infer<typeof claim>;
export type DefillamaClaim = z.infer<typeof defillamaClaim>;
export type CalculatedClaim = z.infer<typeof calculatedClaim>;
export type ClaimsBlock = z.infer<typeof claimsBlock>;

// Per-claim verdict the verifier produces.
export type ClaimStatus = "ok" | "mismatch" | "error";

export interface ClaimResult {
  id: string;
  label: string;
  status: ClaimStatus;
  claimed: number;
  // Live value re-fetched/recomputed. Null when status is "error".
  observed: number | null;
  // Human-readable reason for "mismatch" / "error".
  detail: string | null;
}

export interface VerificationReport {
  pass: boolean;
  asOf: string;
  // Set when as_of itself is in the future.
  dateError: string | null;
  results: ClaimResult[];
  // False when the document carries no <!--occa:claims--> block at all.
  // A `pass: true` + `claimsBlockPresent: false` document verified
  // trivially (nothing to check) — the gate bridge cross-checks it
  // against whether the agent actually used on-chain data tools.
  claimsBlockPresent: boolean;
}
