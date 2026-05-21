// Verifier orchestrator. Takes a story document, extracts its claims
// block, re-fetches every DefiLlama-sourced number, recomputes every
// calculated number, and diffs each against what the agent wrote. The
// verdict is independent of the agent that produced the doc — this is
// the point of truth the pipeline was missing.

import { childLogger } from "../../../../lib/logger";
import { extractClaimsBlock } from "../domain/extract";
import { shapeDefillamaPayload } from "../domain/defillama-shape";
import {
  compareValues,
  evalExpression,
  evalSelector,
} from "../domain/evaluators";
import type {
  ClaimResult,
  VerificationReport,
} from "../domain/schemas";
import { createDefillamaSource, type DefillamaSource } from "./defillama-source";

const log = childLogger("services:workflows:verification");

function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// Verifies one story document against live sources. `now` is injectable
// so the date check is testable; it defaults to the real clock.
export async function verifyStoryDocument(
  doc: string,
  opts: { now?: Date; source?: DefillamaSource } = {},
): Promise<VerificationReport> {
  const now = opts.now ?? new Date();
  const source = opts.source ?? createDefillamaSource();

  const extracted = extractClaimsBlock(doc);
  if (!extracted.ok) {
    if (extracted.reason === "absent") {
      // No claims block = the story declares no on-chain numbers. A
      // regulation, security, business, or policy piece legitimately
      // has nothing for this gate to check — it passes here, but the
      // gate bridge still cross-checks `claimsBlockPresent: false`
      // against whether the agent actually called on-chain tools.
      return {
        pass: true,
        asOf: "",
        dateError: null,
        results: [],
        claimsBlockPresent: false,
      };
    }
    // A block IS present but broken — a genuine failure.
    return {
      pass: false,
      asOf: "",
      dateError: extracted.error,
      results: [],
      claimsBlockPresent: true,
    };
  }
  const block = extracted.block;

  // Date gate: a retrieval date in the future means the agent invented
  // it (typically from a mis-converted Unix timestamp).
  const today = todayUtc(now);
  const dateError =
    block.as_of > today
      ? `as_of ${block.as_of} is in the future (today is ${today})`
      : null;

  const results: ClaimResult[] = [];
  // observed (live) value per claim id, so calculated claims can resolve
  // their expression terms against verified inputs.
  const observed = new Map<string, number>();

  for (const claim of block.claims) {
    try {
      let live: number;
      if (claim.source === "defillama") {
        const raw = await source.get(claim.endpoint);
        // Resolve the selector against the data shaped the way the agent
        // saw it (its `defillama__*` tool output), not the raw endpoint.
        const payload = shapeDefillamaPayload(claim.endpoint, raw);
        live = evalSelector(payload, claim.selector);
      } else {
        live = evalExpression(claim.expression, observed);
      }
      observed.set(claim.id, live);

      const cmp = compareValues(claim.value, live, {
        tolerance: claim.tolerance,
        absTolerance: claim.abs_tolerance,
      });
      results.push({
        id: claim.id,
        label: claim.label,
        status: cmp.ok ? "ok" : "mismatch",
        claimed: claim.value,
        observed: live,
        detail: cmp.ok
          ? null
          : `claimed ${claim.value}, source has ${live} ` +
            `(${cmp.mode} delta ${cmp.delta.toFixed(4)})`,
      });
    } catch (err) {
      results.push({
        id: claim.id,
        label: claim.label,
        status: "error",
        claimed: claim.value,
        observed: null,
        detail: (err as Error).message,
      });
    }
  }

  const pass =
    dateError === null && results.every((r) => r.status === "ok");

  log.info(
    {
      asOf: block.as_of,
      claims: results.length,
      mismatches: results.filter((r) => r.status === "mismatch").length,
      errors: results.filter((r) => r.status === "error").length,
      pass,
    },
    "story verification complete",
  );

  return { pass, asOf: block.as_of, dateError, results, claimsBlockPresent: true };
}
