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
import type { ApprovalDecision, ChannelAction } from "@occa/shared/types";
import { sendUserTurn } from "../../chat/services/chat-handler";
import { decideApproval, type DecideApprovalResult } from "../../approvals/services/decide";
import {
  answerCallbackQuery,
  editMessageText,
  getUpdates,
  sendChatAction,
  sendMessage,
  splitForTelegram,
  type TelegramCallbackQuery,
  type TelegramInlineButton,
  type TelegramInlineKeyboard,
  type TelegramUpdate,
} from "./telegram-api";
import { markStatus } from "../repositories/channels";

const log = childLogger("transport:telegram");

// Canned rejection reason for button-driven rejects. A Telegram inline tap
// can't collect free text in one step, so the service-level reject (which,
// unlike the HTTP route, does not require a reason) records this. Free-text
// reasons are a later text-reply tier, not part of inline buttons.
const TELEGRAM_REJECT_REASON = "Rejected from Telegram";

// Inline-button callback_data wire format. Telegram caps callback_data at
// 64 bytes; "apd:<decision>:<uuid>" fits in ~48. This encoding is private
// to the Telegram transport — producers hand us semantic ChannelActions and
// we own both the render (encode) and the tap (decode) sides.
const CALLBACK_PREFIX = "apd"; // approval decision
const CALLBACK_SEP = ":";

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
  return { companyId: row.companyId!, ownerUserId: row.ownerUserId };
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

function encodeApprovalCallback(
  decision: ApprovalDecision,
  approvalId: string,
): string {
  return [CALLBACK_PREFIX, decision, approvalId].join(CALLBACK_SEP);
}

function parseApprovalCallback(
  data: string,
): { decision: ApprovalDecision; approvalId: string } | null {
  const parts = data.split(CALLBACK_SEP);
  if (parts.length !== 3 || parts[0] !== CALLBACK_PREFIX) return null;
  const [, decision, approvalId] = parts;
  if (decision !== "approve" && decision !== "reject") return null;
  if (!approvalId) return null;
  return { decision, approvalId };
}

// Render semantic ChannelActions into a Telegram inline keyboard. Returns
// undefined when there are no renderable actions (so the message sends as
// plain text). All buttons sit on one row — approvals only ever carry the
// approve/reject pair today.
function actionsToInlineKeyboard(
  actions: ChannelAction[] | undefined,
): TelegramInlineKeyboard | undefined {
  if (!actions || actions.length === 0) return undefined;
  const buttons: TelegramInlineButton[] = [];
  for (const a of actions) {
    if (a.kind !== "approval_decision") continue;
    buttons.push({
      text: a.label,
      callback_data: encodeApprovalCallback(a.decision, a.approvalId),
    });
  }
  if (buttons.length === 0) return undefined;
  return { inline_keyboard: [buttons] };
}

// Map a decision outcome to operator-facing copy: a short toast (shown over
// the chat by answerCallbackQuery) and a resolution line appended to the
// original message after its buttons are stripped.
function describeDecision(
  result: DecideApprovalResult,
  decision: ApprovalDecision,
): { toast: string; resolution: string } {
  switch (result.kind) {
    case "ok":
      return decision === "approve"
        ? { toast: "Approved", resolution: "✅ Approved" }
        : { toast: "Rejected", resolution: "❌ Rejected" };
    case "already_decided":
      return {
        toast: "Already decided",
        resolution: "⚠️ Already decided elsewhere",
      };
    case "not_found":
      return { toast: "Not found", resolution: "⚠️ Approval no longer exists" };
    case "side_effect_failed":
      return {
        toast: "Action failed",
        resolution: `⚠️ Approved, but the action failed: ${result.message}`,
      };
  }
}

// Handle an inline-button tap. 1-on-1 only: the tap must originate from the
// bound private DM (chat.id === stored lastChatId), so a stranger who
// somehow learns the bot handle can't decide the operator's approvals.
async function handleCallback(
  deploymentId: string,
  token: string,
  cbq: TelegramCallbackQuery,
): Promise<void> {
  const data = cbq.data;
  const msg = cbq.message;
  // Need the originating message to gate (chat) and to edit (message_id),
  // plus a payload to act on. Missing either → just clear the spinner.
  if (!data || !msg) {
    await answerCallbackQuery(token, cbq.id);
    return;
  }

  const ch = await loadOneTelegramChannel(deploymentId);
  const boundChatId = Number(ch?.transportState.lastChatId ?? 0);
  if (msg.chat.type !== "private" || msg.chat.id !== boundChatId) {
    log.warn(
      { deploymentId, chatId: msg.chat.id, boundChatId, fromId: cbq.from.id },
      "telegram: callback from non-bound chat — ignoring",
    );
    await answerCallbackQuery(token, cbq.id, "Not authorized.");
    return;
  }

  const parsed = parseApprovalCallback(data);
  if (!parsed) {
    await answerCallbackQuery(token, cbq.id);
    return;
  }

  const owner = await resolveOwnerAndCompany(deploymentId);
  if (!owner) {
    log.warn({ deploymentId }, "telegram: callback owner not found");
    await answerCallbackQuery(token, cbq.id, "Company not found.");
    return;
  }

  // Decide through the exact same service path the OS + HTTP route use.
  const result = await decideApproval({
    approvalId: parsed.approvalId,
    companyId: owner.companyId,
    decidedByUserId: owner.ownerUserId,
    decision: parsed.decision,
    reason: parsed.decision === "reject" ? TELEGRAM_REJECT_REASON : null,
  });

  const { toast, resolution } = describeDecision(result, parsed.decision);
  await answerCallbackQuery(token, cbq.id, toast);
  // Strip the keyboard (omit reply_markup) and append the resolved state so
  // the message reflects the decision and can't be tapped twice.
  const baseText = msg.text ?? "Approval";
  const edited = await editMessageText(
    token,
    msg.chat.id,
    msg.message_id,
    `${baseText}\n\n${resolution}`,
  );
  if (!edited.ok) {
    log.warn(
      { deploymentId, telegramErr: edited.description },
      "telegram: editMessageText after decision failed",
    );
  }
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
        if (u.callback_query) {
          await handleCallback(deploymentId, token, u.callback_query);
        } else if (u.message) {
          await handleMessage(deploymentId, token, u);
          if (u.message.chat.id) lastChatId = u.message.chat.id;
        }
        offset = Math.max(offset, u.update_id + 1);
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
  actions?: ChannelAction[];
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
  // Buttons attach to the final chunk only — a multi-part notification
  // shouldn't repeat the keyboard on every part.
  const keyboard = actionsToInlineKeyboard(args.actions);
  const chunks = splitForTelegram(args.text);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const res = await sendMessage(
      token,
      chatId,
      chunks[i],
      isLast ? keyboard : undefined,
    );
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
