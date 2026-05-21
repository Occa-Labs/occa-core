// Re-shapes a raw DefiLlama payload into the exact structure the agent
// saw when it wrote its claim selectors.
//
// Why this is needed: the agent never sees a raw DefiLlama endpoint. It
// sees the output of its `defillama__*` tools (the crypoch-mcp server),
// and it writes claim selectors that mirror THAT shape. For dex/fees the
// tool keeps the raw field names, so a selector is portable as-is. For
// `chain_tvl` the tool reshapes the raw historical-TVL array — a bare
// `[{date:<epoch>,tvl}]` — into `{ as_of, latest, recent }` with ISO
// dates. An agent therefore writes `recent[date=2026-05-13].tvl`, which
// resolves against the tool output but NOT against the bare array the
// verifier fetches ("recent is not an array"). The verifier must apply
// the identical reshape before resolving a selector.
//
// IMPORTANT: keep this transform in sync with `crypoch-mcp/defillama.mjs`
// (the `chain_tvl` tool + `toIsoDate`). If one changes, the other must.

// DefiLlama timestamps are Unix epoch SECONDS at UTC midnight. Convert
// to a `YYYY-MM-DD` string. Tolerates seconds or milliseconds.
function toIsoDate(epochLike: unknown): string | null {
  const n = Number(epochLike);
  if (!Number.isFinite(n)) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Applies the crypoch-mcp `chain_tvl` reshape to a historical-TVL
// payload; passes every other endpoint through untouched.
export function shapeDefillamaPayload(
  endpoint: string,
  raw: unknown,
): unknown {
  if (endpoint.startsWith("/v2/historicalChainTvl") && Array.isArray(raw)) {
    const recent = raw.slice(-8).map((p) => {
      const point = (p ?? {}) as Record<string, unknown>;
      return { date: toIsoDate(point.date), tvl: point.tvl };
    });
    const latest = recent[recent.length - 1] ?? null;
    return { as_of: latest?.date ?? null, latest, recent };
  }
  return raw;
}
