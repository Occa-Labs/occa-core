"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, History, Send, SquarePen, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { BubbleMarkdown } from "@/components/ui/bubble-markdown";
import type {
  ChatLinkedApproval,
  ChatMessageDTO,
  SendChatMessageResponse,
} from "@occa/shared/types";
import {
  useChatMessages,
  useChatSessionMessages,
  useChatSessions,
  useClearChat,
  useDecideChatApproval,
  useSendChatMessage,
} from "../api/use-ceo-chat";

interface CeoChatWindowProps {
  /** When false, the underlying query is disabled — saves a round-trip
   *  while the panel is closed. */
  active: boolean;
  /** Resolved agent display name, or null when the user hasn't deployed
   *  one yet. The window renders a friendly nudge in that case. */
  ceoName: string | null;
  /** Target a specific owned agent's direct-chat thread. Omit for the
   *  company CEO surface (the shell's floating chat bubble). */
  deploymentId?: string;
  /** When set, render an in-pane header bar (e.g. "You & Aiden Park") with
   *  the New session + History controls. Omit for wrappers that own their
   *  own title bar (the floating CEO bubble). */
  headerLabel?: string;
  /** Fired after a successful send whose reply spawned a task. The
   *  shell uses it to refresh the kanban (cross-feature side-effect
   *  belongs to the composition layer per CLAUDE.md). */
  onTaskCreated?: (task: NonNullable<SendChatMessageResponse["createdTask"]>) => void;
}

// Conversational chat surface for the user ↔ agent thread (Phase 2.5).
// CEO when `deploymentId` is omitted, otherwise a specific owned agent.
// Renders a scrolling message list + composer pinned to the bottom. The
// wrapper (FloatingPanel / Chats pane) owns the title bar + glass shell.
export function CeoChatWindow({
  active,
  ceoName,
  deploymentId,
  headerLabel,
  onTaskCreated,
}: CeoChatWindowProps) {
  const [draft, setDraft] = useState("");
  // null = live (active) session; a number = viewing that past session
  // read-only from History.
  const [viewingGeneration, setViewingGeneration] = useState<number | null>(null);
  const messagesQuery = useChatMessages(deploymentId, active);
  const sendMutation = useSendChatMessage(deploymentId);
  const historyQuery = useChatSessionMessages(deploymentId, viewingGeneration);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewingHistory = viewingGeneration !== null;

  const messages = messagesQuery.data ?? [];
  // Use raw data presence for the loading flag instead of `isPending` —
  // `isPending` can briefly flip during refetches/cancels and was causing
  // the empty-state caption to flicker with the loading caption every
  // few seconds. `data === undefined` is true ONLY on the initial fetch
  // (never again once a response — even an empty array — has landed).
  const hasLoadedOnce = messagesQuery.data !== undefined;
  const showLoading = Boolean(ceoName) && !hasLoadedOnce;
  const showEmpty =
    Boolean(ceoName) && hasLoadedOnce && messages.length === 0;

  // The mutation only knows "pending" while the FE-issued POST is in
  // flight on this tab. After a reload — or in any tab that didn't fire
  // the send — the message list shows the user turn but no assistant
  // reply yet, and the indicator disappears. Derive the same state from
  // the thread itself so reloads still surface "CEO is thinking". Capped
  // at the server-side adapter wait (10 min) so a crashed run doesn't
  // pin the indicator forever.
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const TURN_PENDING_WINDOW_MS = 10 * 60_000;
  const replyPendingFromThread =
    lastMsg?.role === "user" &&
    Date.now() - new Date(lastMsg.createdAt).getTime() < TURN_PENDING_WINDOW_MS;
  const showThinking = sendMutation.isPending || replyPendingFromThread;

  // Autoscroll the list to the bottom whenever a new message lands.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Refocus the composer once the panel becomes active so the user can
  // start typing without a click.
  useEffect(() => {
    if (active && ceoName) taRef.current?.focus();
  }, [active, ceoName]);

  const send = async () => {
    const content = draft.trim();
    if (!content || !ceoName) return;
    setDraft("");
    try {
      const result = await sendMutation.mutateAsync(content);
      if (result.createdTask) {
        onTaskCreated?.(result.createdTask);
      }
    } catch (err) {
      // Swallow — sendMutation.error surfaces the message inline below.
      // Restoring the draft so the user can retry without retyping.
      setDraft(content);
    }
  };

  const sendError = sendMutation.isError
    ? extractError(sendMutation.error)
    : null;

  return (
    <div className="flex flex-col h-full min-h-0">
      {headerLabel && (
        <SessionHeader
          label={headerLabel}
          deploymentId={deploymentId}
          viewingGeneration={viewingGeneration}
          onViewGeneration={setViewingGeneration}
        />
      )}
      {viewingHistory ? (
        <ReadOnlySessionView
          generation={viewingGeneration as number}
          loading={historyQuery.isPending}
          messages={historyQuery.data ?? []}
          onBack={() => setViewingGeneration(null)}
          deploymentId={deploymentId}
        />
      ) : (
        <>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2"
      >
        {!ceoName && !deploymentId && (
          <Alert variant="warning">
            No CEO deployed yet. Deploy one in the Agents window — every
            request routes through your CEO.
          </Alert>
        )}
        {showLoading && (
          <div className="text-xs text-white/30 text-center py-6">
            Loading conversation…
          </div>
        )}
        {showEmpty && (
          <div className="text-xs text-white/30 text-center py-6 leading-relaxed">
            {deploymentId
              ? `Start a direct conversation with ${ceoName}.`
              : "Start the conversation. The CEO will ask clarifying questions before kicking off any work."}
          </div>
        )}
        {messages.map((m) => (
          <ChatBubble key={m.id} message={m} deploymentId={deploymentId} />
        ))}
        {showThinking && (
          <ChatBubble
            message={{
              id: "thinking",
              role: "assistant",
              content: "Thinking…",
              createdTaskId: null,
              linkedApproval: null,
              usage: null,
              createdAt: new Date().toISOString(),
            }}
            muted
          />
        )}
      </div>
      <SessionTotal messages={messages} />
      <div className="px-4 py-3 border-t border-white/8">
        <div className="glass-light rounded-xl px-3 py-2 focus-within:ring-1 focus-within:ring-white/20 transition-shadow">
          <textarea
            ref={taRef}
            disabled={!ceoName || showThinking}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={ceoName ? "Ask, propose, decide…" : ""}
            rows={3}
            className="w-full bg-transparent text-sm text-white/90 outline-none placeholder:text-white/30 resize-none leading-relaxed disabled:opacity-50"
          />
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-[10px] text-white/30">⌘+Enter to send</span>
            <button
              type="button"
              disabled={
                !ceoName || draft.trim().length === 0 || showThinking
              }
              onClick={() => void send()}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/15 text-white/85 disabled:opacity-40 transition-colors"
            >
              <Send className="size-3" />
              {sendMutation.isPending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
        {sendError && (
          <div className="mt-2">
            <Alert variant="error">{sendError}</Alert>
          </div>
        )}
      </div>
        </>
      )}
    </div>
  );
}

// In-pane header for the Chats window: the conversation label on the left,
// New session + History controls on the right, aligned with the name.
function SessionHeader({
  label,
  deploymentId,
  viewingGeneration,
  onViewGeneration,
}: {
  label: string;
  deploymentId?: string;
  viewingGeneration: number | null;
  onViewGeneration: (generation: number | null) => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const sessionsQuery = useChatSessions(deploymentId, historyOpen);
  const clearMutation = useClearChat(deploymentId);
  const sessions = sessionsQuery.data?.sessions ?? [];
  const currentGeneration = sessionsQuery.data?.currentGeneration ?? 0;

  const startNew = async () => {
    setConfirmNew(false);
    setHistoryOpen(false);
    onViewGeneration(null);
    try {
      await clearMutation.mutateAsync();
    } catch {
      /* surfaced by the mutation; the thread stays as-is */
    }
  };

  return (
    <div className="relative flex items-center gap-2 border-b border-white/8 px-4 py-2.5">
      <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-white/85">
        {label}
      </h3>
      {confirmNew ? (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-white/55">New session?</span>
          <button
            type="button"
            onClick={() => setConfirmNew(false)}
            className="cursor-pointer rounded px-1.5 py-0.5 text-white/50 hover:text-white/80"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void startNew()}
            disabled={clearMutation.isPending}
            className="cursor-pointer rounded bg-white/10 px-2 py-0.5 font-medium text-white/85 hover:bg-white/15 disabled:opacity-40"
          >
            Start
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            title="Session history"
            onClick={() => setHistoryOpen((v) => !v)}
            className={`cursor-pointer rounded-md p-1 transition-colors ${
              historyOpen ? "text-white/85 bg-white/10" : "text-white/40 hover:text-white/80"
            }`}
          >
            <History className="size-4" />
          </button>
          <button
            type="button"
            title="New session"
            onClick={() => setConfirmNew(true)}
            className="cursor-pointer rounded-md p-1 text-white/40 transition-colors hover:text-white/80"
          >
            <SquarePen className="size-4" />
          </button>
        </>
      )}
      {historyOpen && (
        <div className="absolute right-3 top-11 z-20 w-56 overflow-hidden rounded-lg border border-white/12 bg-zinc-900/95 shadow-xl backdrop-blur">
          <div className="border-b border-white/8 px-3 py-2 text-[10px] uppercase tracking-wider text-white/40">
            Sessions
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {sessionsQuery.isPending && (
              <div className="px-3 py-2 text-[11px] text-white/35">Loading…</div>
            )}
            {!sessionsQuery.isPending && sessions.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-white/35">No sessions yet</div>
            )}
            {sessions.map((s) => {
              const isCurrent = s.generation === currentGeneration;
              const isViewing = viewingGeneration === s.generation;
              return (
                <button
                  key={s.generation}
                  type="button"
                  onClick={() => {
                    onViewGeneration(isCurrent ? null : s.generation);
                    setHistoryOpen(false);
                  }}
                  className={`flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-white/6 ${
                    isViewing ? "bg-white/8" : ""
                  }`}
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${
                      isCurrent ? "bg-emerald-400" : "bg-white/25"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] text-white/85">
                      {isCurrent ? "Current" : `Session ${s.generation + 1}`}
                    </span>
                    <span className="block truncate text-[10px] text-white/35">
                      {formatSessionStamp(s.lastAt)} · {s.messageCount} msgs
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Read-only transcript of a past session. No composer — History is for
// reviewing, not continuing. "Back" returns to the live session.
function ReadOnlySessionView({
  generation,
  loading,
  messages,
  onBack,
  deploymentId,
}: {
  generation: number;
  loading: boolean;
  messages: ChatMessageDTO[];
  onBack: () => void;
  deploymentId?: string;
}) {
  return (
    <>
      <div className="flex items-center gap-2 border-b border-white/8 bg-white/2 px-4 py-2 text-[11px] text-white/50">
        <span className="flex-1 truncate">
          Viewing Session {generation + 1} · read-only
        </span>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-white/60 hover:text-white/90"
        >
          <ArrowLeft className="size-3" />
          Back
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2">
        {loading && (
          <div className="text-xs text-white/30 text-center py-6">Loading…</div>
        )}
        {!loading && messages.length === 0 && (
          <div className="text-xs text-white/30 text-center py-6">
            This session has no messages.
          </div>
        )}
        {messages.map((m) => (
          <ChatBubble key={m.id} message={m} deploymentId={deploymentId} />
        ))}
      </div>
    </>
  );
}

function formatSessionStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ChatBubble({
  message,
  muted = false,
  deploymentId,
}: {
  message: ChatMessageDTO;
  muted?: boolean;
  deploymentId?: string;
}) {
  if (message.role === "system") {
    return (
      <div className="self-center max-w-[90%] whitespace-pre-line wrap-break-word text-[11px] text-white/45 italic px-2 py-1 text-center">
        {message.content}
      </div>
    );
  }
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`wrap-break-word max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
          isUser
            ? "rounded-br-md bg-sky-500/20 text-sky-50"
            : "rounded-bl-md bg-white/8 text-white/90"
        } ${muted ? "opacity-60" : ""}`}
      >
        <BubbleMarkdown content={message.content} />
        {message.createdTaskId && !isUser && (
          <div className="mt-1.5 text-[10px] text-emerald-300/80">
            Task created
          </div>
        )}
        {message.usage && !isUser && !muted && (
          <div
            className="mt-1.5 text-[10px] text-white/30 tabular-nums"
            title={`${message.usage.tokensIn} in · ${message.usage.tokensOut} out · ${message.usage.cachedTokensIn} cached`}
          >
            {compact(message.usage.tokensIn + message.usage.tokensOut)} tokens ·{" "}
            {dollars(message.usage.costCents)}
          </div>
        )}
        {message.linkedApproval && !isUser && (
          <InlineApprovalCard
            approval={message.linkedApproval}
            deploymentId={deploymentId}
          />
        )}
      </div>
    </div>
  );
}

// Inline Approve/Reject card for a with-approval proposal the CEO queued in
// this reply. Lets the operator commit without a trip to the Approvals
// window; that window stays the canonical record (pending + history).
function InlineApprovalCard({
  approval,
  deploymentId,
}: {
  approval: ChatLinkedApproval;
  deploymentId?: string;
}) {
  const decide = useDecideChatApproval(deploymentId);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const submitting = decide.isPending;

  if (approval.status === "approved") {
    return (
      <div className="mt-2 text-[10px] text-emerald-300/80">
        ✓ Approved · applied
      </div>
    );
  }
  if (approval.status === "rejected") {
    return <div className="mt-2 text-[10px] text-white/40">Rejected</div>;
  }
  // "cancelled" is what a dismiss writes (label "Dismissed" — inlined, not
  // imported, to keep features/chat free of a features/approvals dependency).
  if (approval.status === "cancelled") {
    return <div className="mt-2 text-[10px] text-white/40">Dismissed</div>;
  }
  // Defensive: any other non-pending status is terminal too — never render a
  // live Approve/Reject affordance for a row that already left the queue
  // (it would only 409). Keeps new statuses from falling through to the card.
  if (approval.status !== "pending") {
    return <div className="mt-2 text-[10px] text-white/40">Resolved</div>;
  }

  const fields = Object.entries(approval.payload);
  return (
    <div className="mt-2 rounded-lg border border-white/10 bg-black/25 p-2.5 text-[11px]">
      <div className="mb-1.5 text-[9px] uppercase tracking-wide text-white/35">
        Proposed change
      </div>
      <div className="flex flex-col gap-1.5">
        {fields.map(([k, v]) => (
          <div key={k} className="wrap-break-word">
            <span className="text-white/40">{k}: </span>
            <span className="text-white/80">{formatApprovalValue(v)}</span>
          </div>
        ))}
      </div>
      {rejecting ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason…"
            className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-white/85 placeholder:text-white/30 outline-none focus:border-white/25"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setRejecting(false);
                setReason("");
              }}
              disabled={submitting}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-white/60 hover:text-white/90 disabled:opacity-40"
            >
              <X className="size-3" />
              Cancel
            </button>
            <button
              type="button"
              onClick={() =>
                decide.mutate({
                  id: approval.id,
                  decision: "reject",
                  rejectionReason: reason.trim(),
                })
              }
              disabled={submitting || reason.trim().length === 0}
              className="rounded-md bg-red-500/20 px-2 py-1 text-[11px] font-medium text-red-200 hover:bg-red-500/30 disabled:opacity-40"
            >
              {submitting ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={() => setRejecting(true)}
            disabled={submitting}
            className="rounded-md px-2 py-1 text-[11px] text-white/60 hover:text-white/90 disabled:opacity-40"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={() => decide.mutate({ id: approval.id, decision: "approve" })}
            disabled={submitting}
            className="inline-flex items-center gap-1 rounded-md bg-emerald-500/25 px-2 py-1 text-[11px] font-medium text-emerald-100 hover:bg-emerald-500/35 disabled:opacity-40"
          >
            <Check className="size-3" />
            {submitting ? "Approving…" : "Approve"}
          </button>
        </div>
      )}
    </div>
  );
}

// Render a proposed profile value: arrays as a comma list, everything else
// as a string. Keeps the inline card readable without a full field renderer.
function formatApprovalValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Running token/cost total for the visible session — sums every assistant
// turn's usage. A thin strip above the composer; hidden until at least one
// turn reported usage so a fresh thread stays clean.
function SessionTotal({ messages }: { messages: ChatMessageDTO[] }) {
  let tokens = 0;
  let cents = 0;
  let turns = 0;
  for (const m of messages) {
    if (!m.usage) continue;
    tokens += m.usage.tokensIn + m.usage.tokensOut;
    cents += m.usage.costCents;
    turns += 1;
  }
  if (turns === 0) return null;
  return (
    <div className="flex items-center justify-end gap-2 px-4 pt-2 text-[10px] text-white/30 tabular-nums">
      <span className="uppercase tracking-wider text-white/25">Session</span>
      <span>
        {compact(tokens)} tokens · {dollars(cents)}
      </span>
    </div>
  );
}

function compact(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function extractError(err: unknown): string {
  if (
    typeof err === "object" &&
    err !== null &&
    "body" in err &&
    typeof (err as { body?: { error?: unknown } }).body?.error === "string"
  ) {
    const code = (err as { body: { error: string } }).body.error;
    if (code === "no_company")
      return "You don't have a company yet. Finish onboarding first.";
    if (code === "no_ceo_deployed") return "No CEO deployed yet.";
    if (code === "agent_not_configured")
      return "CEO is not configured. Open the Agents window to finish setup.";
    if (code === "agent_not_provisioned")
      return "CEO is still provisioning. Try again in a moment.";
    if (code === "invalid_body")
      return "Couldn't send that message — please try again.";
    // Adapter-level failures (gateway_*, prompt_*, etc.) are surfaced as
    // a system chat message by the server, not an HTTP error, so they
    // don't reach this branch. Anything else falling through here is an
    // unexpected route-level failure — show a friendly fallback rather
    // than leaking the raw code.
    return "Something went wrong sending that message. Try again.";
  }
  return err instanceof Error ? err.message : "Failed to send.";
}
