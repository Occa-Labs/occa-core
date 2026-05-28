// Channel credentials validation per channel type. Each channel has a
// different secret shape — Telegram needs only a bot token; Slack needs
// a bot token + app token; Matrix needs homeserver URL + access token,
// etc. v1 ships Telegram fully wired; other channels are accepted via
// a permissive base schema and rejected by the adapter sync layer if
// the shape doesn't match what the adapter expects.

import { z } from "zod";
import { CHANNEL_TYPES, type ChannelType } from "@occa/shared/types";

export const channelTypeSchema = z.enum(CHANNEL_TYPES);

// Telegram — BotFather token, format `<bot_id>:<long_alphanumeric>`.
// Length sanity-checked but not regex-strict so future BotFather format
// changes don't block onboarding.
export const telegramCredentialsSchema = z.object({
  botToken: z.string().min(30).max(120),
});

// Permissive fallback for the 12 non-Telegram channels. Records the
// payload as-is so the UI form can store whatever fields it collects;
// the adapter sync layer is responsible for rejecting incomplete shapes.
const genericCredentialsSchema = z
  .record(z.string(), z.unknown())
  .refine((v) => Object.keys(v).length > 0, {
    message: "credentials cannot be empty",
  });

export function credentialsSchemaFor(channelType: ChannelType) {
  switch (channelType) {
    case "telegram":
      return telegramCredentialsSchema;
    default:
      return genericCredentialsSchema;
  }
}

export const channelUpsertSchema = z.object({
  credentials: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional(),
  chatEnabled: z.boolean().optional(),
  notifEnabled: z.boolean().optional(),
});

// Sanitize raw DB credentials into a UI-safe summary. Never returns the
// secret itself — UI just renders a "configured" checkbox.
export function summarizeCredentials(
  channelType: ChannelType,
  raw: unknown,
): Record<string, boolean | string | null> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  if (channelType === "telegram") {
    return { hasBotToken: typeof r.botToken === "string" && r.botToken.length > 0 };
  }
  // Generic: report which top-level keys are populated.
  const out: Record<string, boolean> = {};
  for (const k of Object.keys(r)) {
    out[k] =
      typeof r[k] === "string"
        ? (r[k] as string).length > 0
        : r[k] != null;
  }
  return out;
}
