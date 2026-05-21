// Pull the structured claims block out of a story document. The agent
// embeds it as an HTML comment so it stays invisible in the rendered
// markdown but is trivially extractable here.

import { claimsBlock, type ClaimsBlock } from "./schemas";

// Opening / closing markers of the embedded block:
//   <!--occa:claims
//   { ...json... }
//   -->
const BLOCK_RE = /<!--\s*occa:claims\s*([\s\S]*?)-->/;

// `absent` — no block at all. The verifier treats this as "nothing to
// verify" (a regulation / security / business story with no on-chain
// numbers), not as a failure.
// `malformed` — a block IS present but its JSON or schema is broken.
// That is a genuine failure: the agent tried to declare claims and got
// it wrong.
export type ExtractResult =
  | { ok: true; block: ClaimsBlock }
  | { ok: false; reason: "absent" }
  | { ok: false; reason: "malformed"; error: string };

export function extractClaimsBlock(doc: string): ExtractResult {
  const match = doc.match(BLOCK_RE);
  if (!match) {
    return { ok: false, reason: "absent" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    return {
      ok: false,
      reason: "malformed",
      error: `claims block is not valid JSON: ${(err as Error).message}`,
    };
  }

  const result = claimsBlock.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: "malformed",
      error: `claims block failed schema: ${result.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    };
  }
  return { ok: true, block: result.data };
}
