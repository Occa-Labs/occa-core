// Derive a human display title from markdown content.
//
// Shared by the publish tool (filling the payload's display title when the
// caller didn't pass one) and document auto-save (naming a saved document by
// its own content instead of the generic originating-task title — so a
// pipeline's draft/fact-check stages read as their subject, not "News cycle").
//
// Preference order: first markdown heading → first non-empty line → caller
// fallback. Always trimmed to LIMITS.TITLE.

import { LIMITS } from "./limits";

export function deriveTitleFromContent(
  content: string,
  fallback = "Untitled",
): string {
  const heading = content.match(/^#{1,6}[ \t]+(.+?)[ \t#]*$/m);
  if (heading?.[1]?.trim()) return heading[1].trim().slice(0, LIMITS.TITLE);

  const firstLine = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);

  return (firstLine || fallback).slice(0, LIMITS.TITLE);
}
