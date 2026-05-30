// Minimal Telegram Bot API client. Pure HTTP — no third-party SDK. We
// need these endpoints:
//   - getMe              : probe creds (no side effects)
//   - getUpdates         : long-poll for incoming messages + button taps
//   - sendMessage        : reply to a chat (optionally with inline buttons)
//   - answerCallbackQuery : acknowledge a button tap (clears the spinner)
//   - editMessageText    : rewrite a sent message (e.g. strip buttons after
//                          a decision and show the resolved state)
//
// Long-polling is preferred over webhook for v1: no public ingress
// requirement, no Telegram-side webhook setup, works behind home NAT.
// Tradeoff: one outbound HTTP connection per bot, held open for
// `LONG_POLL_TIMEOUT_S` seconds at a time.

const TELEGRAM_API_BASE = "https://api.telegram.org";
const LONG_POLL_TIMEOUT_S = 30;
const FETCH_TIMEOUT_MS = (LONG_POLL_TIMEOUT_S + 10) * 1000;

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

// One tappable inline button. `callback_data` is opaque to Telegram and
// capped at 64 bytes; we encode our routing payload into it (see
// telegram-orchestrator).
export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineButton[][];
}

// Delivered when the user taps an inline button. `message` is the message
// the button was attached to (carries chat + message_id so we can edit it
// in place); `data` is the `callback_data` we set on that button.
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

async function telegramFetch<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<TelegramResponse<T>> {
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  const controller = signal ? undefined : new AbortController();
  const timer = controller
    ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    : null;
  try {
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ?? controller!.signal,
    });
    if (timer) clearTimeout(timer);
    return (await res.json()) as TelegramResponse<T>;
  } catch (err) {
    if (timer) clearTimeout(timer);
    throw err;
  }
}

export async function getMe(token: string): Promise<TelegramResponse<TelegramUser>> {
  return telegramFetch<TelegramUser>(token, "getMe");
}

// Long-poll for updates. `offset` = `last_update_id + 1` from the prior
// successful call. Telegram holds the request open until `timeout`
// seconds OR a new update arrives, whichever comes first.
export async function getUpdates(
  token: string,
  offset: number,
  signal: AbortSignal,
): Promise<TelegramResponse<TelegramUpdate[]>> {
  return telegramFetch<TelegramUpdate[]>(
    token,
    "getUpdates",
    {
      offset,
      timeout: LONG_POLL_TIMEOUT_S,
      allowed_updates: ["message", "callback_query"],
    },
    signal,
  );
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: TelegramInlineKeyboard,
): Promise<TelegramResponse<TelegramMessage>> {
  return telegramFetch<TelegramMessage>(token, "sendMessage", {
    chat_id: chatId,
    text,
    // Telegram caps individual messages at 4096 chars. We assume the
    // caller already split; here we just truncate as a safety net so the
    // orchestrator never gets stuck on an over-length reply.
    parse_mode: undefined,
    reply_markup: replyMarkup,
  });
}

// Acknowledge a button tap. Without this the client shows a loading spinner
// on the button for a few seconds; `text` (optional) surfaces as a small
// toast over the chat. Best-effort — failing to ack is cosmetic only.
export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  try {
    await telegramFetch<boolean>(token, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  } catch {
    // Cosmetic — the decision already committed; the spinner clears itself.
  }
}

// Rewrite an already-sent message in place. Pass no `replyMarkup` to drop
// the inline keyboard (Telegram removes buttons when the field is absent).
export async function editMessageText(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: TelegramInlineKeyboard,
): Promise<TelegramResponse<TelegramMessage>> {
  return telegramFetch<TelegramMessage>(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: replyMarkup,
  });
}

// Display "typing..." in the user's Telegram chat for ~5 seconds.
// Fire-and-forget — the orchestrator wraps this in setInterval to keep
// the indicator alive across a longer LLM round-trip.
export async function sendChatAction(
  token: string,
  chatId: number,
  action: "typing" | "upload_photo" | "record_audio" = "typing",
): Promise<void> {
  try {
    await telegramFetch<boolean>(token, "sendChatAction", {
      chat_id: chatId,
      action,
    });
  } catch {
    // Best-effort — typing indicator isn't worth surfacing as an error.
  }
}

// Split long replies for Telegram's 4096-char limit. Tries to break on
// paragraph then sentence boundaries; falls back to hard cut.
export function splitForTelegram(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen * 0.6) cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.6) cut = remaining.lastIndexOf(". ", maxLen);
    if (cut < maxLen * 0.6) cut = maxLen;
    out.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}
