// On-chain error decoding — turns raw Solana `TransactionError` values
// (`{ InstructionError: [1, { Custom: 6024 }] }`) into human-readable
// messages sourced from the vendored Anchor IDLs.
//
// Anchor programs share the same custom-error code space (6000+), so a
// code alone is ambiguous across programs — `6000` means different
// things in registry vs treasury. Callers must say which program the
// transaction targeted; payout/disbursement flows are `"treasury"`,
// identity flows are `"registry"`.

import registryIdl from "./idl/registry.json";
import treasuryIdl from "./idl/treasury.json";

export type ChainProgramName = "registry" | "treasury";

export type DecodedChainError = {
  /** Anchor error code (6000+), or null when the error isn't a custom code. */
  code: number | null;
  /** Anchor error name (e.g. "BudgetExceeded"), or null when unknown. */
  name: string | null;
  /** Human-readable explanation. Always set — falls back to the raw error. */
  message: string;
  /** Actionable next step for the user, when one exists. */
  hint: string | null;
};

type IdlErrorEntry = { code: number; name: string; msg: string };

const ERROR_TABLES: Record<ChainProgramName, Map<number, IdlErrorEntry>> = {
  registry: new Map(
    (registryIdl.errors as IdlErrorEntry[]).map((e) => [e.code, e]),
  ),
  treasury: new Map(
    (treasuryIdl.errors as IdlErrorEntry[]).map((e) => [e.code, e]),
  ),
};

// Keyed by error NAME (not code) so a hint applies regardless of which
// program the name comes from. Only codes a user can act on get a hint;
// programmer errors (mismatched PDAs, malformed accounts) stay bare.
const ERROR_HINTS: Record<string, string> = {
  BudgetExceeded:
    "raise the monthly budget for this asset or wait for the period to reset",
  AssetNotBudgeted: "configure a budget for this asset in the treasury policy",
  AssetNotAllowListed: "add this mint to the treasury accepted assets",
  InsufficientFunds: "top up the treasury balance",
  RateLimitExceeded:
    "wait for the period to reset or raise the operations rate limit",
  OperationsRevoked: "re-register disbursement operations for this company",
  OperationsExpired: "re-register disbursement operations for this company",
  UnauthorizedSigner:
    "the server's operator key does not match the registered signer",
  ReceivingAddressUnset: "set a receiving address on the agent's deployment",
  SecondarySignerRequired:
    "this amount is above the policy threshold and needs the secondary signer",
};

// Non-custom `InstructionError` variants come through as bare strings
// (e.g. "InsufficientFundsForRent"). Friendly wording for the ones users
// actually hit; anything else falls back to the variant name itself.
const INSTRUCTION_ERROR_VARIANTS: Record<string, string> = {
  InsufficientFundsForFee: "the fee payer has no SOL left for transaction fees",
  InsufficientFundsForRent:
    "an account in this transaction would drop below rent-exempt minimum",
  AccountNotFound: "an account referenced by this transaction does not exist",
  BlockhashNotFound: "the transaction expired before it reached the network",
};

/**
 * Decode a Solana `TransactionError` (or anything thrown around one) into
 * a structured, human-readable error. Never throws.
 *
 * Pass `program` when the caller knows which program the tx targeted.
 * When omitted, the code is looked up in every table: a code defined in
 * only one program decodes normally, a colliding code reports both
 * candidate meanings rather than guessing.
 */
export function decodeChainError(
  err: unknown,
  program?: ChainProgramName,
): DecodedChainError {
  const bare: DecodedChainError = {
    code: null,
    name: null,
    message: safeStringify(err),
    hint: null,
  };
  if (err == null) return bare;

  if (typeof err === "string") {
    return { ...bare, message: INSTRUCTION_ERROR_VARIANTS[err] ?? err };
  }
  if (typeof err !== "object") return bare;

  const ixErr = (err as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(ixErr) || ixErr.length < 2) return bare;
  const variant = ixErr[1];

  if (typeof variant === "string") {
    return { ...bare, message: INSTRUCTION_ERROR_VARIANTS[variant] ?? variant };
  }

  const code = (variant as { Custom?: unknown } | null)?.Custom;
  if (typeof code !== "number") return bare;

  if (program) {
    const entry = ERROR_TABLES[program].get(code);
    if (!entry) {
      return { ...bare, code, message: `unknown ${program} error code ${code}` };
    }
    return {
      code,
      name: entry.name,
      message: entry.msg,
      hint: ERROR_HINTS[entry.name] ?? null,
    };
  }

  const candidates = (
    Object.entries(ERROR_TABLES) as [ChainProgramName, Map<number, IdlErrorEntry>][]
  )
    .map(([prog, table]) => ({ prog, entry: table.get(code) }))
    .filter((c): c is { prog: ChainProgramName; entry: IdlErrorEntry } =>
      c.entry != null,
    );

  if (candidates.length === 0) {
    return { ...bare, code, message: `unknown program error code ${code}` };
  }
  if (candidates.length === 1) {
    const { entry } = candidates[0];
    return {
      code,
      name: entry.name,
      message: entry.msg,
      hint: ERROR_HINTS[entry.name] ?? null,
    };
  }
  // Same code exists in multiple programs and we don't know which one the
  // tx hit — report every candidate instead of guessing wrong.
  return {
    code,
    name: null,
    message: candidates
      .map((c) => `${c.prog} ${c.entry.name}: ${c.entry.msg}`)
      .join(" — or — "),
    hint: null,
  };
}

/**
 * One-line rendering of `decodeChainError` for logs and UI surfaces:
 * `"BudgetExceeded (6024): budget remaining is insufficient for this
 * disbursement — raise the monthly budget for this asset or wait for the
 * period to reset"`.
 */
export function formatChainError(
  err: unknown,
  program?: ChainProgramName,
): string {
  const decoded = decodeChainError(err, program);
  const label =
    decoded.name && decoded.code != null
      ? `${decoded.name} (${decoded.code}): `
      : "";
  const hint = decoded.hint ? ` — ${decoded.hint}` : "";
  return `${label}${decoded.message}${hint}`;
}

function safeStringify(err: unknown): string {
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? "unknown chain error";
  } catch {
    return "unknown chain error";
  }
}
