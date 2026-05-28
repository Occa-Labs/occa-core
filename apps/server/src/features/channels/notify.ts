// Channel-agnostic outbound notifier. Callers say "push this text to
// this CEO" without knowing which channel(s) are active or how each
// transport authenticates. Each transport registers a push handler;
// adding Discord later = drop a new handler entry, no caller changes.

import { and, eq } from "drizzle-orm";
import { deploymentChannels } from "@occa/shared/schema";
import type { ChannelType } from "@occa/shared/types";
import { db } from "../../infra/database/client";
import { childLogger } from "../../lib/logger";
import { pushTelegramNotification } from "./transport/telegram-orchestrator";

const log = childLogger("services:channel-notify");

export type PushPerChannelResult =
  | { ok: true; info?: Record<string, unknown> }
  | { ok: false; error: string; reason?: string };

interface PushHandlerInput {
  deploymentId: string;
  text: string;
}

type PushHandler = (input: PushHandlerInput) => Promise<PushPerChannelResult>;

// Register a handler per channel type. v1: telegram only. Future
// channels just add their entry here; the dispatcher doesn't need
// to change.
const PUSH_HANDLERS: Partial<Record<ChannelType, PushHandler>> = {
  telegram: pushTelegramNotification,
};

export interface PushNotificationResult {
  delivered: ChannelType[];
  failed: { channel: ChannelType; error: string; reason?: string }[];
  skipped: ChannelType[];
}

// Push to every active channel on this deployment with notifEnabled.
// Best-effort: failures on one channel don't block the others.
export async function pushNotificationToCeo(args: {
  deploymentId: string;
  text: string;
}): Promise<PushNotificationResult> {
  const rows = await db
    .select({
      channelType: deploymentChannels.channelType,
      notifEnabled: deploymentChannels.notifEnabled,
    })
    .from(deploymentChannels)
    .where(
      and(
        eq(deploymentChannels.deploymentId, args.deploymentId),
        eq(deploymentChannels.enabled, true),
      ),
    );

  const delivered: ChannelType[] = [];
  const failed: PushNotificationResult["failed"] = [];
  const skipped: ChannelType[] = [];

  for (const row of rows) {
    const channelType = row.channelType as ChannelType;
    if (!row.notifEnabled) {
      skipped.push(channelType);
      continue;
    }
    const handler = PUSH_HANDLERS[channelType];
    if (!handler) {
      skipped.push(channelType);
      continue;
    }
    try {
      const res = await handler({
        deploymentId: args.deploymentId,
        text: args.text,
      });
      if (res.ok) delivered.push(channelType);
      else failed.push({ channel: channelType, error: res.error, reason: res.reason });
    } catch (err) {
      log.error(
        { err, channelType, deploymentId: args.deploymentId },
        "channel-notify: push handler threw",
      );
      failed.push({
        channel: channelType,
        error: "handler_threw",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { delivered, failed, skipped };
}

// Single-channel push — used by the operator-facing test endpoint so
// the response can report on the specific channel the user clicked.
export async function pushNotificationToChannel(args: {
  deploymentId: string;
  channelType: ChannelType;
  text: string;
}): Promise<PushPerChannelResult> {
  const handler = PUSH_HANDLERS[args.channelType];
  if (!handler) {
    return {
      ok: false,
      error: "channel_unsupported",
      reason: `No transport handler registered for '${args.channelType}'.`,
    };
  }
  return handler({ deploymentId: args.deploymentId, text: args.text });
}
