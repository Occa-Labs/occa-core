"use client";

import { useRef, useState } from "react";
import { MessageCircle, RotateCcw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getTier } from "@occa/shared/role-catalog";
import { CeoChatWindow } from "@/features/chat/components/ceo-chat-window";
import { useClearCeoChat } from "@/features/chat/api/use-ceo-chat";
import { taskKeys } from "@/features/tasks/api/keys";
import { FloatingPanel } from "@/components/ui/floating-panel";

interface AgentRef {
  id: string;
  name: string;
  role: string;
}

// Persistent floating-bubble entry point for the user ↔ CEO chat
// (Phase 2.5 of the hierarchical agent system). Click → opens a real
// conversational chat window. The user only ever talks to CEO; routing
// downstream happens after CEO emits a CREATE_TASK marker mid-thread.
//
// Cross-feature side-effect (refreshing the task list when the chat
// spawns a task) is wired here per CLAUDE.md — features/chat does not
// import features/tasks; the shell composes them.
export function CeoChatBubble({ agents }: { agents: AgentRef[] }) {
  const [open, setOpen] = useState(false);
  const [bubbleRect, setBubbleRect] = useState<DOMRect | null>(null);
  const bubbleRef = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  const clearChat = useClearCeoChat();

  const ceo = agents.find((a) => getTier(a.role) === "ceo") ?? null;

  const handleOpen = () => {
    setBubbleRect(bubbleRef.current?.getBoundingClientRect() ?? null);
    setOpen(true);
  };

  const handleClear = () => {
    if (clearChat.isPending) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Start a new chat? This clears the history and the CEO's session memory.",
      )
    )
      return;
    clearChat.mutate();
  };

  // Header-right control: starts a brand-new conversation. Only shown
  // when a CEO is deployed (otherwise there's nothing to clear).
  const headerRight = ceo ? (
    <button
      type="button"
      onClick={handleClear}
      disabled={clearChat.isPending}
      title="New chat"
      aria-label="New chat"
      className="size-5 rounded-full flex items-center justify-center text-white/40 hover:text-white/85 hover:bg-white/10 disabled:opacity-40 transition-colors"
    >
      <RotateCcw className="size-3" />
    </button>
  ) : null;

  return (
    <>
      {open && (
        <FloatingPanel
          title={ceo ? `Talk to ${ceo.name}` : "Talk to CEO"}
          subtitle={ceo ? "CEO · routes your request" : undefined}
          width={420}
          triggerRect={bubbleRect}
          onClose={() => setOpen(false)}
          backdrop="transparent"
          headerRight={headerRight}
        >
          <CeoChatWindow
            active={open}
            ceoName={ceo?.name ?? null}
            onTaskCreated={() => {
              void queryClient.invalidateQueries({
                queryKey: taskKeys.lists(),
              });
            }}
          />
        </FloatingPanel>
      )}

      <button
        ref={bubbleRef}
        type="button"
        onClick={handleOpen}
        className="fixed bottom-6 right-6 z-50 size-14 rounded-full glass border border-white/15 flex items-center justify-center text-white/80 hover:text-white hover:bg-white/15 transition-colors"
        aria-label="Talk to CEO"
      >
        <MessageCircle className="size-6" />
      </button>
    </>
  );
}
