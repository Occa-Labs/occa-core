// Pure evaluation primitives for the verifier: walk a JSON payload to a
// number (selector), recompute a sum-style expression, and compare a
// claimed value against an observed one. No network, no I/O.

// Default relative tolerance when a claim sets no explicit tolerance.
// 5% absorbs the small drift between write-time and verify-time on a
// rolling-window metric; gross fabrication is orders of magnitude past it.
const DEFAULT_RELATIVE_TOLERANCE = 0.05;

interface Segment {
  key: string;
  // `[field=value]` array filter, or the [last] / [first] positional forms.
  filter?: { field: string; value: string } | "last" | "first";
}

// Split a selector into segments on `.`, ignoring dots inside `[...]`.
function parseSelector(selector: string): Segment[] {
  const raw: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of selector) {
    if (ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
    if (ch === "." && depth === 0) {
      raw.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) raw.push(cur);

  return raw.map((part) => {
    // Key may be empty — a leading `[last]` / `[name=…]` filters the root
    // itself, which is what the historical-TVL endpoint (a bare array)
    // needs.
    const match = part.match(/^([^[]*)(?:\[(.+)\])?$/);
    if (!match) throw new Error(`bad selector segment: "${part}"`);
    const [, key, bracket] = match;
    if (!bracket) return { key };
    if (bracket === "last" || bracket === "first") {
      return { key, filter: bracket };
    }
    const eq = bracket.indexOf("=");
    if (eq === -1) throw new Error(`bad selector filter: "[${bracket}]"`);
    return {
      key,
      filter: {
        field: bracket.slice(0, eq).trim(),
        value: bracket.slice(eq + 1).trim(),
      },
    };
  });
}

// Resolve a selector against a fetched payload to a single number.
// Throws (caught by the caller as an "error" claim) on any mismatch.
export function evalSelector(root: unknown, selector: string): number {
  let node: unknown = root;
  for (const seg of parseSelector(selector)) {
    // An empty key means "stay on the current node" — used so a filter
    // can be applied straight to the root.
    if (seg.key !== "") {
      if (node == null || typeof node !== "object") {
        throw new Error(`cannot read "${seg.key}" — parent is not an object`);
      }
      node = (node as Record<string, unknown>)[seg.key];
    }
    if (seg.filter) {
      if (!Array.isArray(node)) {
        throw new Error(`"${seg.key || "(root)"}" is not an array`);
      }
      if (seg.filter === "last") node = node[node.length - 1];
      else if (seg.filter === "first") node = node[0];
      else {
        const { field, value } = seg.filter;
        const found = node.find(
          (el) =>
            el != null &&
            typeof el === "object" &&
            String((el as Record<string, unknown>)[field]) === value,
        );
        if (found === undefined) {
          throw new Error(`no array element where ${field}="${value}"`);
        }
        node = found;
      }
    }
  }
  if (typeof node !== "number" || Number.isNaN(node)) {
    throw new Error(`selector "${selector}" did not resolve to a number`);
  }
  return node;
}

// Recompute a `+ -` expression of claim-id references and numeric
// literals. Multiplication / division are intentionally unsupported —
// an expression using them throws so the claim surfaces for review
// instead of silently passing.
export function evalExpression(
  expression: string,
  resolved: Map<string, number>,
): number {
  if (/[*/]/.test(expression)) {
    throw new Error("expression uses unsupported operator (* or /)");
  }
  const tokens = expression.match(/[A-Za-z0-9_.]+|[+-]/g) ?? [];
  if (tokens.length === 0) throw new Error("empty expression");

  let acc = 0;
  let sign = 1;
  let sawTerm = false;
  for (const token of tokens) {
    if (token === "+") {
      sign = 1;
      continue;
    }
    if (token === "-") {
      sign = -1;
      continue;
    }
    const ref = resolved.get(token);
    const term = ref ?? Number(token);
    if (Number.isNaN(term)) {
      throw new Error(`unknown term in expression: "${token}"`);
    }
    acc += sign * term;
    sign = 1;
    sawTerm = true;
  }
  if (!sawTerm) throw new Error("expression has no terms");
  return acc;
}

export interface CompareResult {
  ok: boolean;
  // Relative difference, or absolute difference when abs tolerance is used.
  delta: number;
  mode: "relative" | "absolute";
}

// Compare a claimed value against the observed one under the claim's
// tolerance settings.
export function compareValues(
  claimed: number,
  observed: number,
  opts: { tolerance?: number; absTolerance?: number },
): CompareResult {
  if (opts.absTolerance != null) {
    const delta = Math.abs(claimed - observed);
    return { ok: delta <= opts.absTolerance, delta, mode: "absolute" };
  }
  const denom = Math.abs(observed) || 1;
  const delta = Math.abs(claimed - observed) / denom;
  const limit = opts.tolerance ?? DEFAULT_RELATIVE_TOLERANCE;
  return { ok: delta <= limit, delta, mode: "relative" };
}
