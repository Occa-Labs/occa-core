import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { LIMITS } from "../../../lib/limits";
import { StatusCodes } from "http-status-codes";
import { and, eq, isNull } from "drizzle-orm";
import { normalizeGatewayUrl } from "../../../lib/gateway-url";
import { z } from "zod";
import { agentRuntimeProfile, companies, users } from "@occa/shared/schema";
import type { ProbeResponse } from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import { getAdapter } from "../../../lib/adapter-registry";
import { requireAuth } from "../../../middleware/auth";

const router: Router = Router();

const probeBody = z.object({
  gatewayUrl: z.string().url(),
  apiKey: z.string().min(1).max(LIMITS.API_KEY),
});

const hermesProbeBody = z.object({
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
router.post("/openclaw/probe", requireAuth, async (req: Request, res: Response) => {
  const parsed = probeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }

  const userId = req.user!.userId;
  const adapter = getAdapter("openclaw");
  if (!adapter) {
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: ERROR_CODES.INTERNAL_ERROR,
    });
    return;
  }

  // Hand the adapter whatever paired identity the user already has.
  // Lookup priority:
  //   1. An existing agent in this user's company on the SAME gateway —
  //      agents are the source of truth post-provision, and pairing is
  //      per-(gatewayUrl, deviceId).
  //   2. users.pendingDeviceKeypair — onboarding-time fallback before
  //      any agent exists yet on any gateway.
  // Stored URLs are `wss://...` (post adapter scheme rewrite) while the
  // input is typically `https://...`, so the match runs through
  // `normalizeGatewayUrl` in JS rather than a SQL `=`.
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
  const baseConfig: Record<string, unknown> = { ...parsed.data };
  const reusable = existingProfile?.adapterConfig as
    | Record<string, unknown>
    | undefined;
  if (reusable?.deviceKeypair) baseConfig.deviceKeypair = reusable.deviceKeypair;
  if (typeof reusable?.deviceToken === "string") {
    baseConfig.deviceToken = reusable.deviceToken;
  }
  if (!baseConfig.deviceKeypair) {
    const [userRow] = await db
      .select({ pendingDeviceKeypair: users.pendingDeviceKeypair })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const stored = userRow?.pendingDeviceKeypair as
      | Record<string, unknown>
      | null
      | undefined;
    if (stored?.deviceId) {
      baseConfig.deviceKeypair = stored;
      if (typeof stored.deviceToken === "string") {
        baseConfig.deviceToken = stored.deviceToken;
      }
    }
  }

  const result = await adapter.probeConnection(baseConfig);

  // If the adapter prepared / refreshed any persistable state on a
  // successful probe (OpenClaw returns a fresh deviceToken in info,
  // sometimes a newly-minted keypair via configPatch), mirror it back
  // to the user row so the next probe / create can short-circuit
  // re-pairing.
  if (result.ok && result.info) {
    const issuedToken = result.info.deviceToken;
    const keypair = baseConfig.deviceKeypair as
      | Record<string, unknown>
      | undefined;
    if (keypair && typeof issuedToken === "string") {
      await db
        .update(users)
        .set({
          pendingDeviceKeypair: { ...keypair, deviceToken: issuedToken },
        })
        .where(eq(users.id, userId));
    }
  }

  // Same loose-to-narrow cast as the Hermes route below: the adapter
  // contract returns `string | undefined` for `error`; `ProbeResponse`
  // narrows to a known enum. The OpenClaw probe only ever emits values
  // that fall within that enum, so the cast is safe at the boundary.
  const payload: ProbeResponse = {
    ok: result.ok,
    latencyMs: result.latencyMs,
    error: result.error as ProbeResponse["error"],
    info: result.info as ProbeResponse["info"],
  };
  res.status(StatusCodes.OK).json(payload);
});

// POST /api/adapters/hermes/probe
//
// Cheap liveness check: HTTP GET `<gatewayUrl>/v1/capabilities` with the
// supplied bearer token. Returns latency + advertised Hermes version.
// No per-user state is persisted — the Hermes HTTP gateway authenticates
// with a static bearer issued at VPS bootstrap, not a paired device.
router.post("/hermes/probe", requireAuth, async (req: Request, res: Response) => {
  const parsed = hermesProbeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_BODY,
      detail: parsed.error.flatten(),
    });
    return;
  }

  const adapter = getAdapter("hermes");
  if (!adapter) {
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: ERROR_CODES.INTERNAL_ERROR,
    });
    return;
  }
  const result = await adapter.probeConnection(parsed.data);

  // The adapter contract types its return via runtime-core's loose
  // `ProbeResult` (string error, `Record<string, unknown>` info). The
  // shared `ProbeResponse` narrows both — cast at the boundary since
  // the contract intentionally doesn't depend on shared types.
  const payload: ProbeResponse = {
    ok: result.ok,
    latencyMs: result.latencyMs,
    error: result.error as ProbeResponse["error"],
    info: result.info as ProbeResponse["info"],
  };
  res.status(StatusCodes.OK).json(payload);
});

// POST /api/adapters/claude-code/probe
//
// Local mode: runs `claude -p "ok"` on the host to confirm the binary is
// present and the subscription auth resolves. Remote mode (BYORT): when
// `gatewayUrl` is supplied, probeConnection hits the gateway's /v1/health
// instead. The route is mode-agnostic — the adapter branches on the config.
const claudeCodeProbeBody = z.object({
  model: z.string().trim().min(1).max(LIMITS.LABEL).optional(),
  gatewayUrl: z.string().url().optional(),
  apiKey: z.string().min(1).max(LIMITS.API_KEY).optional(),
});

router.post(
  "/claude-code/probe",
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = claudeCodeProbeBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.INVALID_BODY,
        detail: parsed.error.flatten(),
      });
      return;
    }
    const adapter = getAdapter("claude-code");
    if (!adapter) {
      res
        .status(StatusCodes.INTERNAL_SERVER_ERROR)
        .json({ error: ERROR_CODES.INTERNAL_ERROR });
      return;
    }
    const result = await adapter.probeConnection(parsed.data);
    const payload: ProbeResponse = {
      ok: result.ok,
      latencyMs: result.latencyMs,
      error: result.error as ProbeResponse["error"],
      info: result.info as ProbeResponse["info"],
    };
    res.status(StatusCodes.OK).json(payload);
  },
);

export default router;
