// Per-deployment channel endpoints — list, upsert, delete. CEO-only by
// design: server rejects upserts/deletes for any deployment whose role
// isn't CEO_ROLE. UI is expected to filter the surface too, but the
// server is the authority.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { StatusCodes } from "http-status-codes";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { CEO_ROLE } from "@occa/shared/role-catalog";
import type { ChannelDTO } from "@occa/shared/types";
import { requireAuth } from "../../../middleware/auth";
import { findOwnedByUserId } from "../repositories/deployments";
import {
  channelTypeSchema,
  channelUpsertSchema,
} from "../../channels/domain/schemas";
import {
  deleteChannel,
  listChannels,
  upsertChannel,
} from "../../channels/services/sync";
import { pushNotificationToChannel } from "../../channels/notify";
import { reloadTelegramChannel } from "../../channels/transport/telegram-orchestrator";
import { emitNotification } from "../../notifications/services/emit";

const router: Router = Router();

const paramsSchema = z.object({
  id: z.string().uuid(),
  channelType: channelTypeSchema,
});

const listParamsSchema = z.object({
  id: z.string().uuid(),
});

// GET /api/agents/:id/channels — list channels configured for the
// deployment. Non-CEO deployments return an empty array (not 403) so
// the UI can render the section unconditionally without flickering.
router.get(
  "/:id/channels",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = listParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    const deployment = await findOwnedByUserId({
      userId: req.user!.userId,
      deploymentId: parsed.data.id,
    });
    if (!deployment) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    if (deployment.role !== CEO_ROLE) {
      res.json({ channels: [] satisfies ChannelDTO[] });
      return;
    }
    const channels = await listChannels(deployment.id);
    res.json({ channels });
  },
);

// PUT /api/agents/:id/channels/:channelType — upsert credentials +
// trigger adapter sync. Returns the canonical DTO after sync settles.
router.put(
  "/:id/channels/:channelType",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const paramsParsed = paramsSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.CHANNEL_TYPE_INVALID });
      return;
    }
    const bodyParsed = channelUpsertSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({
          error: ERROR_CODES.CHANNEL_CREDENTIALS_INVALID,
          reason: bodyParsed.error.issues.map((i) => i.message).join("; "),
        });
      return;
    }
    const deployment = await findOwnedByUserId({
      userId: req.user!.userId,
      deploymentId: paramsParsed.data.id,
    });
    if (!deployment) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    if (deployment.role !== CEO_ROLE) {
      res
        .status(StatusCodes.FORBIDDEN)
        .json({ error: ERROR_CODES.CHANNEL_NOT_CEO });
      return;
    }

    const result = await upsertChannel({
      deploymentId: deployment.id,
      channelType: paramsParsed.data.channelType,
      credentials: bodyParsed.data.credentials,
      enabled: bodyParsed.data.enabled ?? true,
      chatEnabled: bodyParsed.data.chatEnabled ?? true,
      notifEnabled: bodyParsed.data.notifEnabled ?? true,
    });
    if (!result.ok) {
      if (result.error.code === "credentials_invalid") {
        res.status(StatusCodes.BAD_REQUEST).json({
          error: ERROR_CODES.CHANNEL_CREDENTIALS_INVALID,
          reason: result.error.reason,
        });
        return;
      }
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    if (paramsParsed.data.channelType === "telegram") {
      // Restart the long-poll loop so the new token / enabled flag takes
      // effect without a server bounce. Fire-and-forget: if reload
      // throws, it logs internally — UI already shows "Connected".
      void reloadTelegramChannel(deployment.id);
    }
    res.json({ channel: result.channel });
  },
);

// DELETE /api/agents/:id/channels/:channelType — detach (best-effort
// adapter-side) + drop the row.
router.delete(
  "/:id/channels/:channelType",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = paramsSchema.safeParse(req.params);
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.CHANNEL_TYPE_INVALID });
      return;
    }
    const deployment = await findOwnedByUserId({
      userId: req.user!.userId,
      deploymentId: parsed.data.id,
    });
    if (!deployment) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    if (deployment.role !== CEO_ROLE) {
      res
        .status(StatusCodes.FORBIDDEN)
        .json({ error: ERROR_CODES.CHANNEL_NOT_CEO });
      return;
    }
    await deleteChannel({
      deploymentId: deployment.id,
      channelType: parsed.data.channelType,
    });
    if (parsed.data.channelType === "telegram") {
      // Tear down the long-poll loop after detach so the bot stops
      // routing into a deployment that no longer has credentials.
      void reloadTelegramChannel(deployment.id);
    }
    res.status(StatusCodes.NO_CONTENT).end();
  },
);

// POST /api/agents/:id/channels/:channelType/test-notify — fires a
// hardcoded outbound notification through the channel so operators can
// confirm push works without hooking up real event sources first.
router.post(
  "/:id/channels/:channelType/test-notify",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = paramsSchema.safeParse(req.params);
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.CHANNEL_TYPE_INVALID });
      return;
    }
    const deployment = await findOwnedByUserId({
      userId: req.user!.userId,
      deploymentId: parsed.data.id,
    });
    if (!deployment) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    if (deployment.role !== CEO_ROLE) {
      res
        .status(StatusCodes.FORBIDDEN)
        .json({ error: ERROR_CODES.CHANNEL_NOT_CEO });
      return;
    }
    const result = await pushNotificationToChannel({
      deploymentId: deployment.id,
      channelType: parsed.data.channelType,
      text: `Test notification from OCCA — ${new Date().toLocaleString()}`,
    });
    if (!result.ok) {
      const status =
        result.error === "no_recipient"
          ? StatusCodes.PRECONDITION_FAILED
          : result.error === "channel_unsupported"
            ? StatusCodes.NOT_IMPLEMENTED
            : StatusCodes.BAD_GATEWAY;
      res.status(status).json({
        error: ERROR_CODES.CHANNEL_SYNC_FAILED,
        reason: result.reason ?? result.error,
      });
      return;
    }
    res.json({ ok: true, info: result.info ?? {} });
  },
);

// POST /api/agents/:id/notifications/simulate — fires a sample
// notification through the normal `emitNotification` path so the
// channel fan-out exercises a realistic kind (treasury_readiness for
// now; more kinds can be added without touching the channel layer).
router.post(
  "/:id/notifications/simulate",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = listParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    const deployment = await findOwnedByUserId({
      userId: req.user!.userId,
      deploymentId: parsed.data.id,
    });
    if (!deployment) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    if (deployment.role !== CEO_ROLE) {
      res
        .status(StatusCodes.FORBIDDEN)
        .json({ error: ERROR_CODES.CHANNEL_NOT_CEO });
      return;
    }
    const kind = String(req.body?.kind ?? "treasury_readiness");
    const row = await emitNotification({
      companyId: deployment.companyId!,
      userId: req.user!.userId,
      kind,
      title:
        kind === "treasury_readiness"
          ? "Payroll ready — 3 agents due"
          : `Sample ${kind} notification`,
      body:
        kind === "treasury_readiness"
          ? "0.1250 SOL across 3 agents pending. Open Treasury and run payroll."
          : "This is a sample notification fired for channel testing.",
      payload: { simulated: true },
      link:
        kind === "treasury_readiness" ? "chain:treasury" : null,
    });
    res.json({ ok: true, notificationId: row.id });
  },
);

export default router;
