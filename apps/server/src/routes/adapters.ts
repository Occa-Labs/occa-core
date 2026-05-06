import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { LIMITS } from "../lib/limits";
import { StatusCodes } from "http-status-codes";
import { and, eq, isNull } from "drizzle-orm";
import { normalizeGatewayUrl } from "../lib/gateway-url";
import { z } from "zod";
import {
  deserializeKeypair,
  generateEphemeralKeypair,
  probeConnection,
  serializeKeypair,
  type SerializedKeypair,
} from "@occa/adapter-openclaw";
import { agentRuntimeProfile, companies, users } from "@occa/shared/schema";
import type { ProbeResponse } from "@occa/shared/types";
import { db } from "../infra/database/client";
import { requireAuth } from "../middleware/auth";

const router: Router = Router();

const probeBody = z.object({
  gatewayUrl: z.string().url(),
  apiKey: z.string().min(1).max(LIMITS.API_KEY),
});

// POST /api/adapters/openclaw/probe
//
// Reuses (or lazily generates) a per-user persistent device keypair so the
// same identity is used for every probe AND for the eventual provision call.
// Effect: the user only ever has to manually approve OpenClaw pairing once;
// retries of the probe and the launch step both happen against an already-
// approved device.
//
// Once the gateway issues a deviceToken (after first pair approval), it is
// stashed alongside the keypair on the user row. Subsequent connects replay
// the token so the gateway recognizes the device without re-prompting —
// fixes the "OpenClaw asking to approve OCCA again" bug across restarts.
type StoredDeviceState = SerializedKeypair & { deviceToken?: string };

router.post("/openclaw/probe", requireAuth, async (req: Request, res: Response) => {
  const parsed = probeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }

  const userId = req.user!.userId;

  // Resolve the device identity to probe with. Lookup priority (in order):
  //   1. An existing agent in this user's company **on the SAME gateway URL**
  //      — agents are the SOURCE OF TRUTH for the paired device identity, and
  //      pairing is per-(gatewayUrl, deviceId). An agent paired on gateway A
  //      is meaningless for a probe against gateway B.
  //   2. users.pendingDeviceKeypair — only relevant during initial
  //      onboarding when no agent exists yet on any gateway.
  //   3. Generate fresh + persist to pendingDeviceKeypair (first-ever probe
  //      against this gateway).
  let device;
  let deviceToken: string | undefined;

  // Pull all runtime profiles in user's company; filter by normalized
  // gatewayUrl in JS so we match "wss://gateway.occa.team" (stored after
  // adapter rewrite) with "https://gateway.occa.team/" (typical Hire
  // modal input).
  const userProfiles = await db
    .select({ adapterConfig: agentRuntimeProfile.adapterConfig })
    .from(agentRuntimeProfile)
    .innerJoin(companies, eq(agentRuntimeProfile.companyId, companies.id))
    .where(
      and(
        eq(companies.ownerUserId, userId),
        eq(companies.kind, "user"),
        isNull(companies.deletedAt),
      ),
    );
  const probeKey = normalizeGatewayUrl(parsed.data.gatewayUrl);
  const existingProfile = userProfiles.find((row) => {
    const cfg = row.adapterConfig as Record<string, unknown> | undefined;
    const stored = cfg?.gatewayUrl;
    return typeof stored === "string" && normalizeGatewayUrl(stored) === probeKey;
  });
  const agentCfg = existingProfile?.adapterConfig as
    | Record<string, unknown>
    | undefined;
  const agentKeypair = agentCfg?.deviceKeypair as
    | SerializedKeypair
    | null
    | undefined;
  const agentKeypairValid =
    !!agentKeypair &&
    typeof agentKeypair.deviceId === "string" &&
    typeof agentKeypair.publicKey === "string" &&
    typeof agentKeypair.privateKeyHex === "string";

  if (agentKeypairValid) {
    device = deserializeKeypair(agentKeypair);
    deviceToken =
      typeof agentCfg?.deviceToken === "string" ? agentCfg.deviceToken : undefined;
  } else {
    const [user] = await db
      .select({ pendingDeviceKeypair: users.pendingDeviceKeypair })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const stored = user?.pendingDeviceKeypair as
      | StoredDeviceState
      | null
      | undefined;
    if (stored?.deviceId) {
      device = deserializeKeypair(stored);
      deviceToken = stored.deviceToken;
    } else {
      device = await generateEphemeralKeypair();
      await db
        .update(users)
        .set({ pendingDeviceKeypair: serializeKeypair(device) })
        .where(eq(users.id, userId));
    }
  }

  const result = await probeConnection(parsed.data, { device, deviceToken });

  // Capture (or refresh) the device token after a successful pair —
  // gateway returns it via hello-ok.auth.deviceToken on connect.
  const issuedToken = result.info?.deviceToken;
  if (issuedToken && issuedToken !== deviceToken) {
    await db
      .update(users)
      .set({
        pendingDeviceKeypair: {
          ...serializeKeypair(device),
          deviceToken: issuedToken,
        } satisfies StoredDeviceState,
      })
      .where(eq(users.id, userId));
  }

  const payload: ProbeResponse = {
    ok: result.ok,
    latencyMs: result.latencyMs,
    error: result.error,
    info: result.info,
  };
  res.status(StatusCodes.OK).json(payload);
});

export default router;
