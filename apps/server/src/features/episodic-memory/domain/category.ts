// Coverage categories for the news lane. An episode's category is
// derived from the piece's title + body against this vocabulary. Pure —
// no I/O.

export const CATEGORIES = [
  "regulation",
  "security",
  "business",
  "macro",
  "technology",
  "defi",
  "markets",
] as const;

export type Category = (typeof CATEGORIES)[number];

// Ordered most-specific first: a regulation piece may also mention DeFi,
// so the regulation pattern must win. `defi` and `markets` are the broad
// catch-alls and sit last.
const CATEGORY_PATTERNS: { category: Category; pattern: RegExp }[] = [
  {
    category: "regulation",
    pattern:
      /\b(regulat|\bsec\b|cftc|senate|congress|lawmaker|\bbill\b|legislation|\blaw\b|lawsuit|court|sanction|compliance|clarity act|mica)\b/i,
  },
  {
    category: "security",
    pattern:
      /\b(hack|hacked|exploit|breach|drained|attacker|vulnerabilit|post-mortem|stolen|rug ?pull)\b/i,
  },
  {
    category: "business",
    pattern:
      /\b(funding|fundrais|raised \$|series [a-d]\b|acquisition|acquir|merger|\bm&a\b|ipo|treasury company|lists? on|delist)\b/i,
  },
  {
    category: "macro",
    pattern:
      /\b(federal reserve|\bfed\b|interest rate|bond yield|inflation|geopolit|\bmacro\b)\b/i,
  },
  {
    category: "technology",
    pattern:
      /\b(hard fork|client release|protocol upgrade|\brollup|mainnet|testnet|\beip-|devnet|sequencer)\b/i,
  },
  {
    category: "defi",
    pattern:
      /\b(tvl|\bdex\b|\bdefi\b|liquidity|lending|restaking|\byield\b|\bamm\b|stablecoin)\b/i,
  },
  {
    category: "markets",
    pattern:
      /\b(price|\betf\b|market cap|rally|sell-off|liquidation|volatility|trading volume)\b/i,
  },
];

// First matching category wins. Falls back to "markets" — the broadest
// crypto-news bucket — when nothing matches.
export function deriveCategory(text: string): Category {
  for (const { category, pattern } of CATEGORY_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return "markets";
}
