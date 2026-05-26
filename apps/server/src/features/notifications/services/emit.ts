// Notification emit service — single entrypoint for any feature that
// wants to enqueue a notification for an operator. Keep call sites thin
// and avoid letting features hit the repo directly so the contract stays
// in one place (logging + future fan-out, retry, push channels).

import { childLogger } from "../../../lib/logger";
import { insertOne } from "../repositories/notifications";
import type { NotificationRow } from "../repositories/notifications";

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
  return row;
}
