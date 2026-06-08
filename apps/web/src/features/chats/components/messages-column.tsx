"use client";

// Col 3 of the Chats window — the merged conversation between the
// viewer (Col 1) and the selected partner (Col 2). Messages from every
// shared thread are interleaved in chronological order; a thin separator
// marks each thread boundary so the user can still see where one
// directive context ended and the next began.
//
// Bubble alignment uses the viewer's perspective: bubbles from the
// viewer sit on the right, everyone else on the left. This holds even
// when the viewer is an agent (e.g. when inspecting how Nova replied to
// the CEO, Nova's replies sit on the right).

import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import type { AgentDTO, InboxMessageDTO } from "@occa/shared/types";
import { CEO_ROLE } from "@occa/shared/role-catalog";
import { Star } from "lucide-react";
import { BubbleMarkdown } from "@/components/ui/bubble-markdown";
import { StatusPill } from "@/components/ui/agent-status";
import { useInboxMessages } from "../api/use-inbox-messages";
import { type InboxParty } from "../types";

interface MessagesColumnProps {
  viewer: InboxParty;
  viewerLabel: string;
  partner: InboxParty | null;
  partnerLabel: string | null;
  agents: AgentDTO[];
  /** Render a LIVE chat surface (composer + send) for a direct user↔agent
   *  conversation. Supplied by the shell so features/chats stays free of a
   *  features/chat import. When omitted the column is read-only. */
  renderAgentChat?: (args: {
    deploymentId: string;
    agentName: string;
  }) => ReactNode;
}

export function MessagesColumn({
  viewer,
  viewerLabel,
  partner,
  partnerLabel,
  agents,
  renderAgentChat,
}: MessagesColumnProps) {
  const { messages, loading, error } = useInboxMessages({
    self: viewer,
    partner,
  });

  if (!partner) {
    return (
      <EmptyPane>
        <p className="text-xs text-white/35">Select a conversation</p>
      </EmptyPane>
    );
  }

  // Owner chatting one of their own non-CEO agents → live composer thread
  // (the user_agent surface). Everything else (agent-as-viewer, agent_dm,
  // the CEO row) stays read-only observability.
  if (renderAgentChat && viewer.kind === "user" && partner.kind === "deployment") {
    const agent = agents.find((a) => a.id === partner.deploymentId);
    if (agent && agent.role !== CEO_ROLE) {
      return (
        <div className="flex h-full flex-1 flex-col bg-black/5">
          <div className="flex items-center gap-2 border-b border-white/8 px-4 py-2.5">
            <h3 className="truncate text-xs font-semibold text-white/85">
              {viewerLabel} &amp; {agent.name}
            </h3>
            <StatusPill agent={agent} />
          </div>
          <div className="min-h-0 flex-1">
            {renderAgentChat({
              deploymentId: agent.id,
              agentName: agent.name,
            })}
          </div>
        </div>
      );
    }
  }

  return (
    <div className="flex h-full flex-1 flex-col bg-black/5">
      <Header viewerLabel={viewerLabel} partnerLabel={partnerLabel ?? "—"} />
      <MessagesList
        viewer={viewer}
        agents={agents}
        messages={messages}
        loading={loading}
        error={error}
      />
    </div>
  );
}

function Header({
  viewerLabel,
  partnerLabel,
}: {
  viewerLabel: string;
  partnerLabel: string;
}) {
  return (
    <div className="border-b border-white/8 px-4 py-2.5">
      <h3 className="truncate text-xs font-semibold text-white/85">
        {viewerLabel} &amp; {partnerLabel}
      </h3>
    </div>
  );
}

function MessagesList({
  viewer,
  agents,
  messages,
  loading,
  error,
}: {
  viewer: InboxParty;
  agents: AgentDTO[];
  messages: InboxMessageDTO[];
  loading: boolean;
  error: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom whenever the message set changes — new
  // partner thread opened, new reply landed via the 8s poll, or a
  // refresh after window-focus.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, messages[messages.length - 1]?.id]);

  if (loading && messages.length === 0) {
    return (
      <EmptyPane>
        <p className="text-xs text-white/35">Loading…</p>
      </EmptyPane>
    );
  }
  if (error) {
    return (
      <EmptyPane>
        <p className="text-xs text-red-300/70">{error}</p>
      </EmptyPane>
    );
  }
  if (messages.length === 0) {
    return (
      <EmptyPane>
        <p className="text-xs text-white/35">No messages in this conversation yet</p>
      </EmptyPane>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto px-5 py-4"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2.5">
        {renderRows(messages, viewer, agents)}
      </div>
    </div>
  );
}

function renderRows(
  messages: InboxMessageDTO[],
  viewer: InboxParty,
  agents: AgentDTO[],
) {
  const out: ReactElement[] = [];
  let lastThreadId: string | null = null;

  for (const msg of messages) {
    if (msg.threadId !== lastThreadId) {
      // Key on the first message of the run, not the thread id — the inbox
      // interleaves threads chronologically, so the same thread can recur
      // in non-contiguous runs. Keying by threadId would collide on the
      // second run; the run's lead message id is unique per separator.
      out.push(
        <ThreadSeparator
          key={`sep:${msg.id}`}
          threadKind={msg.threadKind}
          at={msg.createdAt}
        />,
      );
      lastThreadId = msg.threadId;
    }
    if (msg.role === "system") {
      out.push(<SystemRow key={msg.id} message={msg} />);
      continue;
    }
    out.push(
      <Bubble
        key={msg.id}
        message={msg}
        viewer={viewer}
        agents={agents}
      />,
    );
  }
  return out;
}

function ThreadSeparator({
  threadKind,
  at,
}: {
  threadKind: InboxMessageDTO["threadKind"];
  at: string;
}) {
  const label = threadKind === "user_ceo" ? "Direct chat" : "Directive thread";
  return (
    <div className="my-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/35">
      <span className="h-px flex-1 bg-white/8" />
      <span>
        {label} · {formatStamp(at)}
      </span>
      <span className="h-px flex-1 bg-white/8" />
    </div>
  );
}

function Bubble({
  message,
  viewer,
  agents,
}: {
  message: InboxMessageDTO;
  viewer: InboxParty;
  agents: AgentDTO[];
}) {
  const isViewer = isSenderViewer(message, viewer);
  const senderLabel = resolveSenderLabel(message, agents);
  const senderInitial = initial(senderLabel);
  const isUserSender = message.senderKind === "user";

  return (
    <div
      className={`flex items-end gap-2 ${
        isViewer ? "flex-row-reverse" : "flex-row"
      }`}
    >
      <span
        className={`flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-medium ${
          isUserSender
            ? "bg-amber-400/15 text-amber-200"
            : "bg-white/10 text-white/85"
        }`}
        title={senderLabel}
      >
        {isUserSender ? <Star className="size-3.5" /> : senderInitial}
      </span>
      <div
        className={`flex max-w-[72%] flex-col ${
          isViewer ? "items-end" : "items-start"
        }`}
      >
        <span className="mb-0.5 text-[10px] text-white/40">
          {senderLabel} · {formatStamp(message.createdAt)}
        </span>
        <div
          className={`wrap-break-word rounded-2xl px-3.5 py-2 text-[12.5px] leading-relaxed ${
            isViewer
              ? "rounded-br-md bg-sky-500/20 text-sky-50"
              : "rounded-bl-md bg-white/8 text-white/90"
          }`}
        >
          <BubbleMarkdown content={message.content} />
        </div>
      </div>
    </div>
  );
}

function SystemRow({ message }: { message: InboxMessageDTO }) {
  return (
    <div className="my-1 flex justify-center">
      <span className="rounded-full bg-white/5 px-3 py-1 text-[10px] text-white/45">
        {message.content}
      </span>
    </div>
  );
}

function EmptyPane({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 text-center">
      {children}
    </div>
  );
}

function isSenderViewer(msg: InboxMessageDTO, viewer: InboxParty): boolean {
  if (msg.senderKind !== viewer.kind) return false;
  if (viewer.kind === "user") return true;
  return msg.senderId === viewer.deploymentId;
}

function resolveSenderLabel(msg: InboxMessageDTO, agents: AgentDTO[]): string {
  if (msg.senderKind === "user") return "You";
  return agents.find((a) => a.id === msg.senderId)?.name ?? "Agent";
}

function initial(s: string): string {
  return s.trim().charAt(0).toUpperCase() || "?";
}

function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

