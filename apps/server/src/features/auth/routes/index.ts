import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { verifySolanaSignature } from "../../../infra/solana/verify";
import { getPrivyClient } from "../../../infra/privy/client";
import { requireAuth, signToken } from "../../../middleware/auth";
import { NONCE_TTL_MS, buildSignMessage } from "../domain/nonce";
import { pickCanonicalSolanaAddress } from "../domain/privy";
import { SOLANA_ADDR_RE, toAuthUser } from "../domain/users";
import {
  findActiveNonce,
  insertNonce,
  markNonceUsed,
} from "../repositories/auth-nonces";
import {
  findUserById,
  upsertUserByWallet,
} from "../repositories/users";
import { LIMITS } from "../../../lib/limits";
import { childLogger } from "../../../lib/logger";

const log = childLogger("routes:auth");

const router: Router = Router();

const nonceBody = z.object({
  walletAddress: z.string().regex(SOLANA_ADDR_RE, "invalid wallet address"),
});

const verifyBody = z.object({
  walletAddress: z.string().regex(SOLANA_ADDR_RE, "invalid wallet address"),
  nonce: z.string().min(LIMITS.NONCE_MIN).max(LIMITS.NONCE_MAX),
  signature: z.string().min(LIMITS.SIGNATURE_MIN).max(LIMITS.SIGNATURE_MAX),
});

// POST /api/auth/nonce
router.post("/nonce", async (req: Request, res: Response) => {
  const parsed = nonceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }
  const { walletAddress } = parsed.data;
  const nonce = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

  await insertNonce({ walletAddress, nonce, expiresAt });

  const message = buildSignMessage(walletAddress, nonce, expiresAt);
  res.json({ nonce, message, expiresAt: expiresAt.toISOString() });
});

// POST /api/auth/verify
router.post("/verify", async (req: Request, res: Response) => {
  const parsed = verifyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }
  const { walletAddress, nonce, signature } = parsed.data;

  const nonceRow = await findActiveNonce({ walletAddress, nonce, now: new Date() });
  if (!nonceRow) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.NONCE_INVALID_OR_EXPIRED });
    return;
  }

  const message = buildSignMessage(walletAddress, nonce, nonceRow.expiresAt);
  const valid = await verifySolanaSignature(walletAddress, signature, message);
  if (!valid) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: ERROR_CODES.SIGNATURE_INVALID });
    return;
  }

  // Atomically mark nonce used (guards replay if two verify hits race)
  const claimed = await markNonceUsed(nonceRow.id);
  if (!claimed) {
    res.status(StatusCodes.CONFLICT).json({ error: ERROR_CODES.NONCE_ALREADY_USED });
    return;
  }

  const userRow = await upsertUserByWallet(walletAddress);

  const token = signToken({ userId: userRow.id, walletAddress: userRow.walletAddress });
  res.json({ token, user: toAuthUser(userRow) });
});

// POST /api/auth/privy — accept a Privy access token, extract the user's
// linked Solana wallet, and issue an OCCA JWT (24h). Replaces the
// nonce/sign flow for clients using the Privy frontend SDK; both can
// coexist while the web migration completes.
const privyBody = z.object({
  accessToken: z.string().min(1),
});

router.post("/privy", async (req: Request, res: Response) => {
  const parsed = privyBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }

  // verifyAuthToken throws on invalid / expired / wrong-app tokens.
  let claims;
  try {
    const privy = getPrivyClient();
    claims = await privy.verifyAuthToken(parsed.data.accessToken);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("privy_not_configured")) {
      res
        .status(StatusCodes.INTERNAL_SERVER_ERROR)
        .json({ error: ERROR_CODES.PRIVY_NOT_CONFIGURED });
      return;
    }
    req.log.warn({ err }, "privy token verify failed");
    res
      .status(StatusCodes.UNAUTHORIZED)
      .json({ error: ERROR_CODES.PRIVY_TOKEN_INVALID });
    return;
  }

  // verifyAuthToken returns userId (`did:privy:...`); fetch the full user
  // record to read linked accounts.
  const privy = getPrivyClient();
  const user = await privy.getUser(claims.userId);
  const walletAddress = pickCanonicalSolanaAddress(user);
  if (!walletAddress) {
    log.info({ privyDid: claims.userId }, "privy user has no solana wallet");
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.PRIVY_NO_SOLANA_WALLET });
    return;
  }

  if (!SOLANA_ADDR_RE.test(walletAddress)) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.PRIVY_NO_SOLANA_WALLET });
    return;
  }

  const userRow = await upsertUserByWallet(walletAddress);
  const token = signToken({
    userId: userRow.id,
    walletAddress: userRow.walletAddress,
  });
  res.json({ token, user: toAuthUser(userRow) });
});

// GET /api/auth/me
router.get("/me", requireAuth, async (req: Request, res: Response) => {
  const row = await findUserById(req.user!.userId);
  if (!row) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: ERROR_CODES.USER_NOT_FOUND });
    return;
  }
  res.json({ user: toAuthUser(row) });
});

export default router;
