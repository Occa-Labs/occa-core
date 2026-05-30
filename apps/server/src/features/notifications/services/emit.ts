// Notification emit service — single entrypoint for any feature that
// wants to enqueue a notification for an operator. Keep call sites thin
// and avoid letting features hit the repo directly so the contract stays
// in one place (logging + future fan-out, retry, push channels).

import { childLogger } from "../../../lib/logger";
import { insertOne } from "../repositories/notifications";
import type { NotificationRow } from "../repositories/notifications";
import { findCeoForCompany } from "../../agents/repositories/deployments";
import { pushNotificationToCeo } from "../../channels/notify";
import type { ChannelAction } from "@occa/shared/types";

const log = childLogger("services:notifications:emit");

export interface EmitNotificationInput {
  companyId: string;
  userId: string;
  kind: string;
  title: string;
  body?: string | null;
  payload?: Record<string, unknown>;
  /** Deep-link target, e.g. "approvals:<uuid>" or "chain:treasury". */
  link?: string | null;
  // Interactive actions for channels that support them (e.g. Telegram
  // inline buttons). The in-app inbox ignores these — it resolves the
  // notification through `link`. Forwarded as-is to the channel fan-out.
  actions?: ChannelAction[];
}

export async function emitNotification(
  input: EmitNotificationInput,
): Promise<NotificationRow> {
  const row = await insertOne({
    companyId: input.companyId,
    userId: input.userId,
    kind: input.kind,
    title: input.title,
    body: input.body ?? null,
    payload: input.payload ?? {},
    link: input.link ?? null,
  });
  log.info(
    { id: row.id, kind: row.kind, userId: row.userId, companyId: row.companyId },
    "notification emitted",
  );

  // Fan-out to external channels (Telegram, future Discord/Slack/...).
  // Best-effort: a delivery failure does NOT roll back the persisted
  // notification — the in-app inbox is the source of truth, channels
  // are convenience. The dispatcher handles `notifEnabled` per channel
  // so users who only want chat (not push) on a given channel stay
  // unbothered.
  void pushAfterEmit(input, row.id).catch((err) => {
    log.warn({ err, notifId: row.id }, "channel push after emit failed");
  });

  return row;
}

async function pushAfterEmit(
  input: EmitNotificationInput,
  notifId: string,
): Promise<void> {
  const ceo = await findCeoForCompany(input.companyId);
  if (!ceo) return;
  const text = formatForChannel(input);
  const res = await pushNotificationToCeo({
    deploymentId: ceo.id,
    text,
    actions: input.actions,
  });
  if (res.delivered.length > 0 || res.failed.length > 0) {
    log.info(
      {
        notifId,
        delivered: res.delivered,
        failed: res.failed,
        skipped: res.skipped,
      },
      "channel push fan-out done",
    );
  }
}

function formatForChannel(input: EmitNotificationInput): string {
  // Plain-text format suitable for Telegram + most chat platforms.
  // Two lines: title (bold-equivalent via uppercase prefix) and body.
  // Link is omitted — operator still resolves it from the in-app inbox
  // since channel surfaces don't share OCCA auth.
  const lines = [input.title];
  if (input.body && input.body.length > 0) {
    lines.push("");
    lines.push(input.body);
  }
  return lines.join("\n");
}
