"use client";

import { AlertTriangle, Plus, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  CHANNEL_TYPES,
  type ChannelDTO,
  type ChannelType,
} from "@occa/shared/types";
import { Modal } from "@/components/ui/modal";
import { ApiError } from "@/lib/api";
import type { AgentDTO } from "@occa/shared/types";
import { useAgentChannels } from "../api/use-agent-channels";

// Display-side names. Server stores the canonical slug; UI maps to the
// brand label the user recognizes.
const CHANNEL_LABEL: Record<ChannelType, string> = {
  telegram: "Telegram",
  discord: "Discord",
  whatsapp: "WhatsApp",
  slack: "Slack",
  signal: "Signal",
  matrix: "Matrix",
  mattermost: "Mattermost",
  line: "LINE",
  feishu: "Feishu",
  qqbot: "QQ Bot",
  bluebubbles: "iMessage",
  googlechat: "Google Chat",
  msteams: "Microsoft Teams",
};

// 1-2 letter monogram per channel. Treatment stays monochrome on
// glass-tinted bg to keep the picker grid visually quiet — adding real
// brand SVGs is the right end-state, but in the meantime colored letter
// chips read as noise next to the rest of the OCCA OS chrome.
const CHANNEL_MONO: Record<ChannelType, string> = {
  telegram: "TG",
  discord: "DC",
  whatsapp: "WA",
  slack: "SL",
  signal: "SG",
  matrix: "MX",
  mattermost: "MM",
  line: "LN",
  feishu: "FS",
  qqbot: "QQ",
  bluebubbles: "iM",
  googlechat: "GC",
  msteams: "MT",
};

// Channels prioritized in the picker — visible first as 2-col tile grid,
// rest collapsed below as a denser 3-col grid. Order = adoption skew
// based on Hermes + OpenClaw user reports, not personal ranking.
const POPULAR_CHANNELS: ChannelType[] = [
  "telegram",
  "discord",
  "whatsapp",
  "slack",
];

// Channels with a working end-to-end transport on the OCCA side. UI
// shows an "Available" badge to nudge users toward what actually works;
// the others save credentials to DB but don't yet relay messages.
const TRANSPORT_READY: ReadonlySet<ChannelType> = new Set([]);

function BrandChip({ type, size }: { type: ChannelType; size: "sm" | "md" }) {
  const dim = size === "md" ? "size-8 text-[11px]" : "size-6 text-[10px]";
  return (
    <span
      className={`${dim} inline-flex items-center justify-center rounded-md bg-white text-zinc-900 font-semibold tracking-tight shrink-0`}
      aria-hidden
    >
      {CHANNEL_MONO[type]}
    </span>
  );
}

const STATUS_LABEL: Record<ChannelDTO["status"], string> = {
  off: "Off",
  connecting: "Connecting",
  connected: "Connected",
  error: "Error",
};

const STATUS_DOT: Record<ChannelDTO["status"], string> = {
  off: "bg-white/30",
  connecting: "bg-amber-400/80",
  connected: "bg-emerald-400/90",
  error: "bg-red-400/90",
};

// Section host. Rendered conditionally by the SettingsTab caller (CEO
// only — the server enforces too).
export function ChannelsSection({ agent }: { agent: AgentDTO }) {
  const { channels, loading, error, save, detach, testNotify } =
    useAgentChannels(agent.id, true);
  const [modalChannel, setModalChannel] = useState<ChannelType | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pingState, setPingState] = useState<
    Record<string, { busy: boolean; msg: string | null }>
  >({});

  const handleTestPing = async (channelType: ChannelType) => {
    setPingState((s) => ({
      ...s,
      [channelType]: { busy: true, msg: null },
    }));
    try {
      await testNotify(channelType);
      setPingState((s) => ({
        ...s,
        [channelType]: { busy: false, msg: "Sent — check Telegram." },
      }));
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? (err.body as { reason?: string })?.reason ?? `HTTP ${err.status}`
          : "Failed.";
      setPingState((s) => ({
        ...s,
        [channelType]: { busy: false, msg },
      }));
    }
    setTimeout(
      () =>
        setPingState((s) => ({
          ...s,
          [channelType]: { busy: false, msg: null },
        })),
      4_000,
    );
  };

  const activeTypes = useMemo(
    () => new Set(channels.filter((c) => c.enabled).map((c) => c.channelType)),
    [channels],
  );
  const addable = useMemo(
    () => CHANNEL_TYPES.filter((c) => !activeTypes.has(c)),
    [activeTypes],
  );

  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold text-white/55 uppercase tracking-wider">
        Channels
      </h3>
      <p className="text-[12px] text-white/55">
        External chat surfaces that route user&harr;CEO conversations. Configure
        a bot or integration here and the runtime adapter wires up the
        connection.
      </p>

      {error && (
        <div className="flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-300 ring-1 ring-inset ring-red-500/18">
          <AlertTriangle className="size-3.5 shrink-0" />
          {error}
        </div>
      )}

      <div className="space-y-1.5">
        {loading && channels.length === 0 ? (
          <p className="text-[12px] text-white/40">Loading…</p>
        ) : channels.length === 0 ? (
          <p className="text-[12px] text-white/40">
            No channels configured yet.
          </p>
        ) : (
          channels.map((c) => (
            <ChannelRow
              key={c.channelType}
              channel={c}
              ping={pingState[c.channelType]}
              onEdit={() => setModalChannel(c.channelType)}
              onDetach={() => void detach(c.channelType)}
              onTestPing={() => void handleTestPing(c.channelType)}
            />
          ))
        )}
      </div>

      <div className="pt-1">
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          disabled={addable.length === 0}
          className="inline-flex items-center gap-1.5 rounded-md bg-white/8 hover:bg-white/12 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1.5 text-xs font-medium text-white/80 hover:text-white transition-colors cursor-pointer"
        >
          <Plus className="size-3" />
          Add channel
        </button>
      </div>

      <AddChannelPicker
        open={addOpen}
        addable={addable}
        onPick={(t) => {
          setAddOpen(false);
          setModalChannel(t);
        }}
        onClose={() => setAddOpen(false)}
      />

      <ChannelEditModal
        channelType={modalChannel}
        existing={
          modalChannel
            ? channels.find((c) => c.channelType === modalChannel) ?? null
            : null
        }
        onClose={() => setModalChannel(null)}
        onSave={async (type, creds) => {
          await save(type, { credentials: creds, enabled: true });
          setModalChannel(null);
        }}
      />
    </section>
  );
}

function ChannelRow({
  channel,
  ping,
  onEdit,
  onDetach,
  onTestPing,
}: {
  channel: ChannelDTO;
  ping?: { busy: boolean; msg: string | null };
  onEdit: () => void;
  onDetach: () => void;
  onTestPing: () => void;
}) {
  // `enabled` is the master on/off switch (what the CEO's TOGGLE_CHANNEL
  // flips); `status` is connection health. A channel can be connected but
  // disabled — surface the disabled state so turning it off is visible,
  // not hidden behind a still-green "Connected".
  const isDisabled = !channel.enabled;
  return (
    <div
      className={`flex items-center gap-3 rounded-md bg-white/5 px-3 py-2 ${
        isDisabled ? "opacity-60" : ""
      }`}
    >
      <BrandChip type={channel.channelType} size="sm" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-white/85">
            {CHANNEL_LABEL[channel.channelType]}
          </span>
          <span
            className={`size-1.5 rounded-full shrink-0 ${
              isDisabled ? "bg-white/25" : STATUS_DOT[channel.status]
            }`}
            title={isDisabled ? "Disabled" : STATUS_LABEL[channel.status]}
          />
          <span className="text-[10px] uppercase tracking-wider text-white/40">
            {isDisabled ? "Disabled" : STATUS_LABEL[channel.status]}
          </span>
          {isDisabled && channel.status === "connected" && (
            <span className="text-[9px] tracking-wide text-white/30">
              (connection ok)
            </span>
          )}
        </div>
        {channel.statusMsg && (
          <p className="text-[11px] text-red-300/80 mt-0.5 truncate">
            {channel.statusMsg}
          </p>
        )}
        {ping?.msg && (
          <p className="text-[11px] text-white/55 mt-0.5 truncate">
            {ping.msg}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onTestPing}
        disabled={ping?.busy}
        className="rounded-md bg-white/6 hover:bg-white/12 px-2 py-1 text-[11px] text-white/75 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
      >
        {ping?.busy ? "Sending…" : "Test ping"}
      </button>
      <button
        type="button"
        onClick={onEdit}
        className="rounded-md bg-white/6 hover:bg-white/12 px-2 py-1 text-[11px] text-white/75 hover:text-white transition-colors cursor-pointer"
      >
        Edit
      </button>
      <button
        type="button"
        onClick={onDetach}
        aria-label={`Disconnect ${CHANNEL_LABEL[channel.channelType]}`}
        className="rounded-md hover:bg-white/8 p-1 text-white/55 hover:text-red-300 transition-colors cursor-pointer"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function AddChannelPicker({
  open,
  addable,
  onPick,
  onClose,
}: {
  open: boolean;
  addable: ChannelType[];
  onPick: (type: ChannelType) => void;
  onClose: () => void;
}) {
  if (!open) return null;

  const addableSet = new Set(addable);
  const popular = POPULAR_CHANNELS.filter((c) => addableSet.has(c));
  const more = addable.filter((c) => !POPULAR_CHANNELS.includes(c));

  return (
    <Modal open={open} onClose={onClose} title="Add channel">
      <div className="px-5 py-5 space-y-4">
        <p className="text-[12px] text-white/55">
          Pick a platform to configure. You can wire up more later.
        </p>

        {popular.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-white/40 mb-2">
              Popular
            </p>
            <div className="grid grid-cols-2 gap-2">
              {popular.map((t) => (
                <PickerTile
                  key={t}
                  type={t}
                  onPick={onPick}
                  size="md"
                />
              ))}
            </div>
          </div>
        )}

        {more.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-white/40 mb-2">
              More
            </p>
            <div className="grid grid-cols-3 gap-2">
              {more.map((t) => (
                <PickerTile
                  key={t}
                  type={t}
                  onPick={onPick}
                  size="sm"
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function PickerTile({
  type,
  onPick,
  size,
}: {
  type: ChannelType;
  onPick: (type: ChannelType) => void;
  size: "sm" | "md";
}) {
  const ready = TRANSPORT_READY.has(type);
  return (
    <button
      type="button"
      onClick={() => onPick(type)}
      className={
        size === "md"
          ? "flex items-center gap-3 rounded-md bg-white/6 hover:bg-white/12 px-3 py-3 text-left transition-colors cursor-pointer"
          : "flex flex-col items-start gap-2 rounded-md bg-white/6 hover:bg-white/12 px-2.5 py-2.5 text-left transition-colors cursor-pointer"
      }
    >
      <BrandChip type={type} size={size === "md" ? "md" : "sm"} />
      <div className="min-w-0 flex-1">
        <div
          className={
            size === "md"
              ? "text-[13px] font-medium text-white/85 truncate"
              : "text-[11.5px] font-medium text-white/85 truncate"
          }
        >
          {CHANNEL_LABEL[type]}
        </div>
        {ready && (
          <span className="inline-block mt-1 rounded-sm bg-emerald-500/15 text-emerald-300 text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 ring-1 ring-inset ring-emerald-400/22">
            Available
          </span>
        )}
      </div>
    </button>
  );
}

// Per-channel setup modal. v1 ships Telegram with the proper form; other
// 12 channels render the same single-field token form for now (server
// will reject if the adapter doesn't support them yet, which surfaces as
// an error on the row).
function ChannelEditModal({
  channelType,
  existing,
  onClose,
  onSave,
}: {
  channelType: ChannelType | null;
  existing: ChannelDTO | null;
  onClose: () => void;
  onSave: (
    type: ChannelType,
    credentials: Record<string, string>,
  ) => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setToken("");
    setError(null);
    setSubmitting(false);
  }, []);

  if (!channelType) return null;

  const onSubmit = async () => {
    if (!token.trim()) {
      setError("Token required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const credField = channelType === "telegram" ? "botToken" : "token";
      await onSave(channelType, { [credField]: token.trim() });
      reset();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? (err.body as { reason?: string })?.reason ?? `HTTP ${err.status}`
          : "Failed to save channel.";
      setError(msg);
      setSubmitting(false);
    }
  };

  const labelHint =
    channelType === "telegram"
      ? "BotFather token (looks like 123456789:AAH...)."
      : `Token / API key for ${CHANNEL_LABEL[channelType]}.`;

  return (
    <Modal
      open={channelType !== null}
      onClose={() => {
        reset();
        onClose();
      }}
      title={`${existing ? "Edit" : "Add"} ${CHANNEL_LABEL[channelType]}`}
    >
      <div className="px-5 py-5 space-y-4">
        <div>
          <label className="block text-[11px] uppercase tracking-wider text-white/55 mb-1">
            Token
          </label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={labelHint}
            className="w-full rounded-md bg-white/6 px-3 py-2 text-[13px] text-white placeholder:text-white/35 ring-1 ring-inset ring-white/8 focus:ring-white/22 outline-none"
          />
          <p className="text-[10.5px] text-white/40 mt-1">{labelHint}</p>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-300 ring-1 ring-inset ring-red-500/18">
            <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={submitting}
            className="rounded-md bg-white/6 hover:bg-white/12 px-3 py-1.5 text-xs font-medium text-white/75 hover:text-white transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting}
            className="rounded-md bg-white/18 hover:bg-white/26 px-3 py-1.5 text-xs font-medium text-white transition-colors cursor-pointer disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
