"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ChatMessageDTO,
  ListChatMessagesResponse,
  SendChatMessageResponse,
} from "@occa/shared/types";
import { chatApi } from "@/lib/api";
import { chatKeys } from "./keys";

// Polling cadence — short while the panel is open since the user is
// actively waiting for replies. SSE / WebSocket can replace this once
// real-time stream support lands. Window-focus refetch off because the
// chat panel is modal-ish; tab swap shouldn't drop a turn.
const REFETCH_INTERVAL_MS = 3_000;

export function useCeoChatMessages(enabled: boolean) {
  return useQuery({
    queryKey: chatKeys.ceo(),
    queryFn: async () => {
      const { messages } = await chatApi.ceo.list();
      return messages;
    },
    enabled,
    refetchInterval: enabled ? REFETCH_INTERVAL_MS : false,
    refetchOnWindowFocus: false,
  });
}

// Send a turn. Optimistic-appends the user message into the cache so the
// FE renders the user bubble immediately while waiting for the server
// reply. On success, replaces the optimistic row with the server-issued
// row and appends the assistant reply. Also invalidates the task list
// when the reply spawned a task so the kanban reflects it.
export function useSendCeoMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (content: string) => chatApi.ceo.send({ content }),
    onMutate: async (content) => {
      await queryClient.cancelQueries({ queryKey: chatKeys.ceo() });
      const previous =
        queryClient.getQueryData<ChatMessageDTO[]>(chatKeys.ceo()) ?? [];
      const optimistic: ChatMessageDTO = {
        id: `optimistic-${Date.now()}`,
        role: "user",
        content,
        createdTaskId: null,
        createdAt: new Date().toISOString(),
      };
      queryClient.setQueryData<ChatMessageDTO[]>(chatKeys.ceo(), [
        ...previous,
        optimistic,
      ]);
      return { previous, optimisticId: optimistic.id };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) {
        queryClient.setQueryData<ChatMessageDTO[]>(chatKeys.ceo(), ctx.previous);
      }
    },
    onSuccess: (data: SendChatMessageResponse, _vars, ctx) => {
      // Merge with dedupe-by-id. The 3s polling refetch can land DURING
      // the server-side mutation processing — when it does, the freshly
      // inserted user/assistant rows arrive in the cache before this
      // onSuccess runs. A naive append would then duplicate them. Build
      // a fresh list, drop the optimistic row, and append only the ids
      // that weren't already present.
      queryClient.setQueryData<ChatMessageDTO[]>(chatKeys.ceo(), (old) => {
        const seen = new Set<string>();
        const merged: ChatMessageDTO[] = [];
        for (const m of old ?? []) {
          if (m.id === ctx?.optimisticId) continue;
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          merged.push(m);
        }
        if (!seen.has(data.user.id)) {
          seen.add(data.user.id);
          merged.push(data.user);
        }
        if (data.assistant && !seen.has(data.assistant.id)) {
          seen.add(data.assistant.id);
          merged.push(data.assistant);
        }
        return merged;
      });
      // Cross-feature side-effect (refreshing the kanban when CEO spawns
      // a task) is the consumer's concern — features/chat doesn't reach
      // into features/tasks. The shell wires this via mutation.onSuccess.
    },
    onSettled: () => {
      // A polling tick may overlap with the mutation; ensure the cache
      // converges to the server-of-record list once the dust settles.
      void queryClient.invalidateQueries({ queryKey: chatKeys.ceo() });
    },
  });
}

// Fallback shape for places that just want the raw query result and
// don't care about the mutation.
export function emptyMessages(): ListChatMessagesResponse {
  return { messages: [] };
}

// Wipe the chat thread server-side. After success the cache is reset to
// an empty array immediately so the UI clears without a polling-tick
// delay. Settled-invalidate forces the next list query to confirm with
// the server (in case another tab raced).
export function useClearCeoChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => chatApi.ceo.clear(),
    onSuccess: () => {
      queryClient.setQueryData<ChatMessageDTO[]>(chatKeys.ceo(), []);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.ceo() });
    },
  });
}
