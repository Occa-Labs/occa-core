// Display formatter for agent role slugs. Roles arrive as lowercase
// underscore-separated strings (`ceo`, `head_editorial`, `onchain_analyst`).
// Raw rendering — `HEAD_EDITORIAL` via CSS uppercase — looks shouty and
// eats horizontal space, so we map to readable labels:
//
//   ceo               → "CEO"
//   head_editorial    → "Head of Editorial"
//   onchain_analyst   → "On-chain Analyst"
//   senior_writer     → "Senior Writer"
//
// Two-to-four-character roles are treated as acronyms (CEO/CTO/CFO/etc.)
// and left uppercase. Anything longer is title-cased word by word, with
// special-cased compound words.

const ACRONYM_MAX_LEN = 4;

const SPECIAL_LABELS: Record<string, string> = {
  // Compound prefixes that look weird if naïvely capitalised. Add here
  // when a role token needs a custom rendering — keep alphabetical.
  onchain: "On-chain",
};

const HEAD_PREFIX = "head_";

export function formatRoleLabel(role: string): string {
  const slug = role.trim().toLowerCase();
  if (slug.length === 0) return "";

  // Short slugs without underscores → acronym (CEO, CTO, CHRO, CISO …).
  if (slug.length <= ACRONYM_MAX_LEN && !slug.includes("_")) {
    return slug.toUpperCase();
  }

  // `head_<area>` → "Head of <Area>" — the most common composite role
  // shape in the kickoff catalog. Renders shorter than "HEAD_EDITORIAL"
  // and reads as a job title.
  if (slug.startsWith(HEAD_PREFIX)) {
    const tail = slug.slice(HEAD_PREFIX.length);
    return `Head of ${titleCase(tail)}`;
  }

  return titleCase(slug);
}

function titleCase(slug: string): string {
  return slug
    .split("_")
    .map((part) => SPECIAL_LABELS[part] ?? capitalize(part))
    .join(" ");
}

function capitalize(word: string): string {
  if (word.length === 0) return word;
  // Treat short tokens (≤ ACRONYM_MAX_LEN) as acronyms even mid-phrase
  // (e.g. `cs_lead` → "CS Lead"). Skips this when the token has any
  // digits, since "v1" shouldn't become "V1".
  if (word.length <= ACRONYM_MAX_LEN && !/\d/.test(word)) {
    return word.toUpperCase();
  }
  return word[0].toUpperCase() + word.slice(1);
}
