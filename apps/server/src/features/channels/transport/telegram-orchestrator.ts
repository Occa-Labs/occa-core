// Telegram orchestrator. Long-polls enabled telegram channels, routes
// incoming user messages through the same `sendUserTurn` chat handler
// the web client uses, and replies via Telegram's sendMessage. Single
// long-running loop per (deployment, channel).
//
// Lifecycle:
//   - `startOrchestrator()` at server boot: snapshots enabled telegram
//     channels and spawns a loop per row.
//   - `reloadChannel(deploymentId)`: called by the upsert/delete route
//     so a token change or detach takes effect without a server restart.
//   - `stopOrchestrator()`: graceful shutdown; aborts every in-flight
//     long-poll and waits for loops to settle.

import { and, eq } from "drizzle-orm";
import { childLogger } from "../../../lib/logger";
import { db } from "../../../infra/database/client";
import {
  companies,
  deploymentChannels,
  deployments,
} from "@occa/shared/schema";
import { sendUserTurn } from "../../chat/services/chat-handler";
import {
  getUpdates,
  sendChatAction,
  sendMessage,
  splitForTelegram,
  type TelegramUpdate,
} from "./telegram-api";
import { markStatus } from "../repositories/channels";

const log = childLogger("transport:telegram");

interface ActiveLoop {
  controller: AbortController;
  promise: Promise<void>;
}

// One loop per deployment. Re-entrancy guarded by checking the map
// before spawning; reload tears the old loop down first.
const LOOPS = new Map<string, ActiveLoop>();
let bootSnapshotDone = false;

interface ChannelRow {
  deploymentId: string;
  credentials: Record<string, unknown>;
  transportState: Record<string, unknown>;
}

async function loadEnabledTelegramChannels(): Promise<ChannelRow[]> {
  const rows = await db
    .select({
      deploymentId: deploymentChannels.deploymentId,
      credentials: deploymentChannels.credentials,
      transportState: deploymentChannels.transportState,
    })
    .from(deploymentChannels)
    .where(
      and(
        eq(deploymentChannels.channelType, "telegram"),
        eq(deploymentChannels.enabled, true),
      ),
    );
  return rows.map((r) => ({
    deploymentId: r.deploymentId,
    credentials: r.credentials as Record<string, unknown>,
    transportState: (r.transportState ?? {}) as Record<string, unknown>,
  }));
}

async function loadOneTelegramChannel(deploymentId: string): Promise<ChannelRow | null> {
  const [row] = await db
    .select({
      deploymentId: deploymentChannels.deploymentId,
      credentials: deploymentChannels.credentials,
      transportState: deploymentChannels.transportState,
      enabled: deploymentChannels.enabled,
    })
    .from(deploymentChannels)
    .where(
      and(
        eq(deploymentChannels.deploymentId, deploymentId),
        eq(deploymentChannels.channelType, "telegram"),
      ),
    )
    .limit(1);
  if (!row || !row.enabled) return null;
  return {
    deploymentId: row.deploymentId,
    credentials: row.credentials as Record<string, unknown>,
    transportState: (row.transportState ?? {}) as Record<string, unknown>,
  };
}

async function resolveOwnerAndCompany(
  deploymentId: string,
): Promise<{ companyId: string; ownerUserId: string } | null> {
  const [row] = await db
    .select({
      companyId: deployments.companyId,
      ownerUserId: companies.ownerUserId,
    })
    .from(deployments)
    .innerJoin(companies, eq(companies.id, deployments.companyId))
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!row || !row.ownerUserId) return null;
  return { companyId: row.companyId, ownerUserId: row.ownerUserId };
}

async function persistTransportState(
  deploymentId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  // Read-modify-write so concurrent fields (pollingOffset, lastChatId,
  // future per-chat metadata) don't trample each other. Loop is single
  // threaded per deployment so no race within the orchestrator itself —
  // this is just defensive against external writers (UI updates).
  const [row] = await db
    .select({ transportState: deploymentChannels.transportState })
    .from(deploymentChannels)
    .where(
      and(
        eq(deploymentChannels.deploymentId, deploymentId),
        eq(deploymentChannels.channelType, "telegram"),
      ),
    )
    .limit(1);
  const next = { ...((row?.transportState ?? {}) as object), ...patch };
  await db
    .update(deploymentChannels)
    .set({
      transportState: next,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deploymentChannels.deploymentId, deploymentId),
        eq(deploymentChannels.channelType, "telegram"),
      ),
    );
}

async function handleMessage(
  deploymentId: string,
  token: string,
  update: TelegramUpdate,
): Promise<void> {
  const msg = update.message;
  if (!msg || !msg.text || msg.from?.is_bot) return;

  const owner = await resolveOwnerAndCompany(deploymentId);
  if (!owner) {
    log.warn({ deploymentId }, "telegram: deployment owner not found");
    return;
  }

  // "Typing..." indicator. Telegram's sendChatAction shows the indicator
  // for ~5s per call, so refresh every 4s until the LLM round-trip
  // finishes. Fire-and-forget — we clear the interval in `finally`
  // regardless of how the chat-handler resolves.
  await sendChatAction(token, msg.chat.id);
  const typingTimer = setInterval(() => {
    void sendChatAction(token, msg.chat.id);
  }, 4_000);

  let reply: string;
  try {
    const result = await sendUserTurn({
      companyId: owner.companyId,
      userId: owner.ownerUserId,
      content: msg.text,
    });
    if (result.kind === "ok") {
      reply = result.assistant.content;
    } else if (result.kind === "adapter_failed") {
      reply = result.assistant.content;
    } else {
      reply = "(no CEO available)";
    }
  } catch (err) {
    log.error({ err, deploymentId }, "telegram: chat handler threw");
    reply = "Sorry, something went wrong on my side.";
  } finally {
    clearInterval(typingTimer);
  }

  for (const chunk of splitForTelegram(reply)) {
    const res = await sendMessage(token, msg.chat.id, chunk);
    if (!res.ok) {
      log.warn(
        { deploymentId, telegramErr: res.description },
        "telegram: sendMessage failed",
      );
      break;
    }
  }
}

async function loop(
  channel: ChannelRow,
  controller: AbortController,
): Promise<void> {
  const { deploymentId } = channel;
  const token = String(channel.credentials.botToken ?? "");
  if (!token) {
    log.warn({ deploymentId }, "telegram: missing botToken — skipping loop");
    return;
  }

  let offset = Number(channel.transportState.pollingOffset ?? 0);
  let consecutiveErrors = 0;

  log.info({ deploymentId, offset }, "telegram: starting poll loop");
  await markStatus({
    deploymentId,
    channelType: "telegram",
    status: "connected",
    statusMsg: null,
  });

  while (!controller.signal.aborted) {
    try {
      const res = await getUpdates(token, offset, controller.signal);
      if (controller.signal.aborted) break;
      if (!res.ok) {
        log.warn(
          { deploymentId, telegramErr: res.description, code: res.error_code },
          "telegram: getUpdates non-ok",
        );
        if (res.error_code === 401) {
          await markStatus({
            deploymentId,
            channelType: "telegram",
            status: "error",
            statusMsg: "Bot token rejected by Telegram (401).",
          });
          break;
        }
        consecutiveErrors += 1;
        await sleep(Math.min(5000 * consecutiveErrors, 30_000));
        continue;
      }
      consecutiveErrors = 0;
      const updates = res.result ?? [];
      let lastChatId: number | null = null;
      for (const u of updates) {
        await handleMessage(deploymentId, token, u);
        offset = Math.max(offset, u.update_id + 1);
        if (u.message?.chat.id) lastChatId = u.message.chat.id;
      }
      if (updates.length > 0) {
        const patch: Record<string, unknown> = { pollingOffset: offset };
        if (lastChatId !== null) patch.lastChatId = lastChatId;
        await persistTransportState(deploymentId, patch);
      }
    } catch (err) {
      if (controller.signal.aborted) break;
      consecutiveErrors += 1;
      log.warn(
        { err, deploymentId, consecutiveErrors },
        "telegram: poll iteration threw",
      );
      await sleep(Math.min(5000 * consecutiveErrors, 30_000));
    }
  }
  log.info({ deploymentId }, "telegram: poll loop ended");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnLoop(channel: ChannelRow): void {
  const existing = LOOPS.get(channel.deploymentId);
  if (existing) return;
  const controller = new AbortController();
  const promise = loop(channel, controller).catch((err) => {
    log.error(
      { err, deploymentId: channel.deploymentId },
      "telegram: loop crashed",
    );
  });
  LOOPS.set(channel.deploymentId, { controller, promise });
}

async function stopLoop(deploymentId: string): Promise<void> {
  const active = LOOPS.get(deploymentId);
  if (!active) return;
  LOOPS.delete(deploymentId);
  active.controller.abort();
  await active.promise.catch(() => {});
}

export async function startTelegramOrchestrator(): Promise<void> {
  if (bootSnapshotDone) return;
  bootSnapshotDone = true;
  const channels = await loadEnabledTelegramChannels();
  log.info({ count: channels.length }, "telegram: boot snapshot");
  for (const ch of channels) spawnLoop(ch);
}

// Hot-reload entry point: called by the channel route after upsert /
// delete so credential changes propagate without restarting the server.
export async function reloadTelegramChannel(deploymentId: string): Promise<void> {
  await stopLoop(deploymentId);
  const fresh = await loadOneTelegramChannel(deploymentId);
  if (fresh) spawnLoop(fresh);
}

export async function stopTelegramOrchestrator(): Promise<void> {
  const ids = Array.from(LOOPS.keys());
  await Promise.all(ids.map((id) => stopLoop(id)));
  bootSnapshotDone = false;
}

// Telegram-side push handler — internal transport implementation.
// Registered with the generic `pushNotificationToCeo` dispatcher in
// `features/channels/notify.ts`; callers should go through that
// dispatcher, not this directly. Telegram disallows bots from messaging
// strangers, so we route to the *last* chat_id that DM'd the bot. If
// the user has never DM'd the bot yet, returns `no_recipient`.
export async function pushTelegramNotification(args: {
  deploymentId: string;
  text: string;
}): Promise<
  | { ok: true; info: { chatId: number } }
  | { ok: false; error: string; reason?: string }
> {
  const ch = await loadOneTelegramChannel(args.deploymentId);
  if (!ch) return { ok: false, error: "no_channel" };
  const token = String(ch.credentials.botToken ?? "");
  const chatId = Number(ch.transportState.lastChatId);
  if (!token) return { ok: false, error: "no_channel" };
  if (!chatId) {
    return {
      ok: false,
      error: "no_recipient",
      reason:
        "Send a message to the bot from Telegram first so it knows where to push.",
    };
  }
  for (const chunk of splitForTelegram(args.text)) {
    const res = await sendMessage(token, chatId, chunk);
    if (!res.ok) {
      return {
        ok: false,
        error: "send_failed",
        reason: res.description ?? `code ${res.error_code}`,
      };
    }
  }
  return { ok: true, info: { chatId } };
}
