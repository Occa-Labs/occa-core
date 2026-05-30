"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Send, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { BubbleMarkdown } from "@/components/ui/bubble-markdown";
import type {
  ChatLinkedApproval,
  ChatMessageDTO,
  SendChatMessageResponse,
} from "@occa/shared/types";
import {
  useCeoChatMessages,
  useDecideCeoApproval,
  useSendCeoMessage,
} from "../api/use-ceo-chat";

interface CeoChatWindowProps {
  /** When false, the underlying query is disabled — saves a round-trip
   *  while the panel is closed. */
  active: boolean;
  /** Resolved CEO display name, or null when the user hasn't deployed
   *  one yet. The window renders a friendly nudge in that case. */
  ceoName: string | null;
  /** Fired after a successful send whose reply spawned a task. The
   *  shell uses it to refresh the kanban (cross-feature side-effect
   *  belongs to the composition layer per CLAUDE.md). */
  onTaskCreated?: (task: NonNullable<SendChatMessageResponse["createdTask"]>) => void;
}

// Conversational chat surface for the user ↔ CEO thread (Phase 2.5).
// Renders a scrolling message list + composer pinned to the bottom. The
// FloatingPanel that wraps this owns the title bar + glass shell.
export function CeoChatWindow({
  active,
  ceoName,
  onTaskCreated,
}: CeoChatWindowProps) {
  const [draft, setDraft] = useState("");
  const messagesQuery = useCeoChatMessages(active);
  const sendMutation = useSendCeoMessage();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2"
      >
        {!ceoName && (
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
            Start the conversation. The CEO will ask clarifying questions
            before kicking off any work.
          </div>
        )}
        {messages.map((m) => (
          <ChatBubble key={m.id} message={m} />
        ))}
        {showThinking && (
          <ChatBubble
            message={{
              id: "thinking",
              role: "assistant",
              content: "Thinking…",
              createdTaskId: null,
              linkedApproval: null,
              createdAt: new Date().toISOString(),
            }}
            muted
          />
        )}
      </div>
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
    </div>
  );
}

function ChatBubble({
  message,
  muted = false,
}: {
  message: ChatMessageDTO;
  muted?: boolean;
}) {
  if (message.role === "system") {
    return (
      <div className="self-center text-[11px] text-white/40 italic px-2 py-1">
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
        {message.linkedApproval && !isUser && (
          <InlineApprovalCard approval={message.linkedApproval} />
        )}
      </div>
    </div>
  );
}

// Inline Approve/Reject card for a with-approval proposal the CEO queued in
// this reply. Lets the operator commit without a trip to the Approvals
// window; that window stays the canonical record (pending + history).
function InlineApprovalCard({ approval }: { approval: ChatLinkedApproval }) {
  const decide = useDecideCeoApproval();
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
