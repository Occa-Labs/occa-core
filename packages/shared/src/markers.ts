// Control markers that agents embed in replies to signal intent to OCCA.
// These are for backend use only — never surface them to end users.
//
// Two formats:
//
// 1. Single-tag flags: `[[OCCA:TOKEN]]`
//      Used for boolean signals (REVIEW, BLOCKED).
//
// 2. Block markers: `[[OCCA:TOKEN]]\n<JSON body>\n[[/OCCA:TOKEN]]`
//      Used for structured action requests (HIRE, DELEGATE) where the
//      agent ships a payload alongside the intent. The dispatcher parses
//      the JSON body and creates an approval row server-side, mirroring
//      what would happen if the agent had POSTed to /api/agents/me/approvals.
//      Block markers are an alternative to the HTTP path for environments
//      where the agent cannot reliably make outbound HTTP calls.
//
// Examples:
//   [[OCCA:REVIEW]]                       — flag review needed
//   [[OCCA:HIRE]] {...} [[/OCCA:HIRE]]    — request to hire a new agent
//   [[OCCA:DELEGATE]] {...} [[/OCCA:DELEGATE]] — request to delegate to existing agent

export const OCCA_MARKER_REGEX = /\[\[OCCA:[A-Z_]+\]\]/g;

// Matches a full block marker including its closing tag. Greedy across
// newlines so JSON payloads with nested braces work. The `[\s\S]*?` is
// non-greedy so multiple blocks in the same reply parse independently.
export const OCCA_BLOCK_REGEX =
  /\[\[OCCA:([A-Z_]+)\]\]([\s\S]*?)\[\[\/OCCA:\1\]\]/g;

export function hasOccaMarker(text: string, token: string): boolean {
  return text.includes(`[[OCCA:${token}]]`);
}

export interface OccaActionBlock {
  /** The token portion, e.g. "HIRE" or "DELEGATE". */
  token: string;
  /** Parsed JSON body if valid; null when the body wasn't valid JSON. */
  body: Record<string, unknown> | null;
  /** Raw body text between the open + close tags, untrimmed. */
  raw: string;
  /** True if the body parsed cleanly as a JSON object. */
  parsed: boolean;
}

/**
 * Extract every `[[OCCA:TOKEN]]…[[/OCCA:TOKEN]]` block in `text`.
 * Bodies that fail JSON.parse are still returned with `parsed=false` so
 * callers can decide how strict to be (warn vs reject vs ignore).
 */
export function extractActionBlocks(text: string): OccaActionBlock[] {
  const blocks: OccaActionBlock[] = [];
  // Iterate manually so the regex's `g` flag advances `lastIndex` across
  // matches without us re-allocating per call.
  const re = new RegExp(OCCA_BLOCK_REGEX.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = m[1];
    const raw = m[2];
    let body: Record<string, unknown> | null = null;
    let parsed = false;
    try {
      const cleaned = raw.trim();
      const stripped = cleaned
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      const v = JSON.parse(stripped);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        body = v as Record<string, unknown>;
        parsed = true;
      }
    } catch {
      // leave parsed=false; caller decides what to do
    }
    blocks.push({ token, body, raw, parsed });
  }
  return blocks;
}

/**
 * Remove every `[[OCCA:*]]` single-tag flag AND every block marker from
 * `text`, then normalize whitespace. Call after `extractActionBlocks` so
 * the persisted reply never leaks markers to end users.
 */
export function stripOccaMarkers(text: string): string {
  return text
    .replace(OCCA_BLOCK_REGEX, "")
    .replace(OCCA_MARKER_REGEX, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
