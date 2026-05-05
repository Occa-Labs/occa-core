import type { Request, Response, NextFunction } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import jwt from "jsonwebtoken";
import type { AuthTokenPayload } from "@occa/shared/types";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET env var is required");
}

export function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET!, { expiresIn: "24h" });
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : null;
  if (!token) {
    res
      .status(StatusCodes.UNAUTHORIZED)
      .json({ error: ERROR_CODES.MISSING_TOKEN });
    return;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET!) as AuthTokenPayload;
    req.user = payload;
    next();
  } catch {
    res
      .status(StatusCodes.UNAUTHORIZED)
      .json({ error: ERROR_CODES.INVALID_TOKEN });
  }
}

// Dev-only allowlist for destructive endpoints (DB reset, gateway reset,
// orphan GC). Reads `OCCA_DEV_WALLETS` (comma-separated Solana base58
// addresses, case-sensitive). Fail-closed: if the env var is unset or
// empty in production, every request is rejected. The middleware MUST be
// composed AFTER `requireAuth` so `req.user.walletAddress` is populated.
//
// Threat model:
//   - Stolen JWT for a non-dev user → still rejected (wallet mismatch).
//   - Dev forgot to set env on a fresh deploy → rejected by default.
//   - Allowlist comparison is constant-time-ish (Set lookup on a small
//     list); not a high-value side channel here.
function loadDevWalletAllowlist(): Set<string> {
  const raw = process.env.OCCA_DEV_WALLETS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

let devWalletAllowlist: Set<string> | null = null;
function getDevWalletAllowlist(): Set<string> {
  // Cache once per process — env doesn't change at runtime, and reparsing
  // on every request is wasteful. Tests can reset by reassigning.
  if (devWalletAllowlist === null) {
    devWalletAllowlist = loadDevWalletAllowlist();
  }
  return devWalletAllowlist;
}

export function requireDevWallet(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const wallet = req.user?.walletAddress;
  if (!wallet) {
    res
      .status(StatusCodes.UNAUTHORIZED)
      .json({ error: ERROR_CODES.MISSING_TOKEN });
    return;
  }
  const allowlist = getDevWalletAllowlist();
  if (allowlist.size === 0) {
    res.status(StatusCodes.FORBIDDEN).json({
      error: ERROR_CODES.DEV_WALLET_NOT_CONFIGURED,
      detail:
        "OCCA_DEV_WALLETS is not set; destructive dev endpoints are disabled.",
    });
    return;
  }
  if (!allowlist.has(wallet)) {
    res.status(StatusCodes.FORBIDDEN).json({ error: ERROR_CODES.FORBIDDEN });
    return;
  }
  next();
}
