"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type {
  ChatMessageDTO,
  ListChatMessagesResponse,
  SendChatMessageResponse,
} from "@occa/shared/types";
import { approvalsApi, chatApi } from "@/lib/api";
import { chatKeys } from "./keys";

// Polling cadence — short while the panel is open since the user is
// actively waiting for replies. SSE / WebSocket can replace this once
// real-time stream support lands. Window-focus refetch off because the
// chat panel is modal-ish; tab swap shouldn't drop a turn.
const REFETCH_INTERVAL_MS = 3_000;

// A chat target is either the company CEO (deploymentId omitted) or a
// specific owned agent. Both share identical wire shapes — only the
// endpoint + cache key differ — so every hook below is written once
// against this resolver and the CEO-named exports are thin wrappers.
interface ChatTarget {
  key: QueryKey;
  list: () => Promise<ListChatMessagesResponse>;
  send: (input: { content: string }) => Promise<SendChatMessageResponse>;
  clear: () => Promise<void>;
}

function resolveTarget(deploymentId?: string): ChatTarget {
  if (deploymentId) {
    const api = chatApi.agent(deploymentId);
    return { key: chatKeys.agent(deploymentId), ...api };
  }
  return { key: chatKeys.ceo(), ...chatApi.ceo };
}

// ── Generic hooks (CEO surface when deploymentId is omitted) ──────────────

export function useChatMessages(
  deploymentId: string | undefined,
  enabled: boolean,
) {
  const target = resolveTarget(deploymentId);
  return useQuery({
    queryKey: target.key,
    queryFn: async () => {
      const { messages } = await target.list();
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
// row and appends the assistant reply.
export function useSendChatMessage(deploymentId?: string) {
  const queryClient = useQueryClient();
  const target = resolveTarget(deploymentId);

  return useMutation({
    mutationFn: async (content: string) => target.send({ content }),
    onMutate: async (content) => {
      await queryClient.cancelQueries({ queryKey: target.key });
      const previous =
        queryClient.getQueryData<ChatMessageDTO[]>(target.key) ?? [];
      const optimistic: ChatMessageDTO = {
        id: `optimistic-${Date.now()}`,
        role: "user",
        content,
        createdTaskId: null,
        linkedApproval: null,
        createdAt: new Date().toISOString(),
      };
      queryClient.setQueryData<ChatMessageDTO[]>(target.key, [
        ...previous,
        optimistic,
      ]);
      return { previous, optimisticId: optimistic.id };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) {
        queryClient.setQueryData<ChatMessageDTO[]>(target.key, ctx.previous);
      }
    },
    onSuccess: (data: SendChatMessageResponse, _vars, ctx) => {
      // Merge with dedupe-by-id. The 3s polling refetch can land DURING
      // the server-side mutation processing — when it does, the freshly
      // inserted user/assistant rows arrive in the cache before this
      // onSuccess runs. A naive append would then duplicate them. Build
      // a fresh list, drop the optimistic row, and append only the ids
      // that weren't already present.
      queryClient.setQueryData<ChatMessageDTO[]>(target.key, (old) => {
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
    },
    onSettled: () => {
      // A polling tick may overlap with the mutation; ensure the cache
      // converges to the server-of-record list once the dust settles.
      void queryClient.invalidateQueries({ queryKey: target.key });
    },
  });
}

// Wipe the chat thread server-side. After success the cache is reset to
// an empty array immediately so the UI clears without a polling-tick
// delay. Settled-invalidate forces the next list query to confirm.
export function useClearChat(deploymentId?: string) {
  const queryClient = useQueryClient();
  const target = resolveTarget(deploymentId);
  return useMutation({
    mutationFn: async () => target.clear(),
    onSuccess: () => {
      queryClient.setQueryData<ChatMessageDTO[]>(target.key, []);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: target.key });
    },
  });
}

// Decide a CEO-proposed approval inline from the chat card (Approve/Reject
// on the message that queued it). Calls the shared approvals endpoint via
// lib — NOT the approvals feature — so the no-cross-feature-import rule
// holds. Refetches the thread on success so the card reflects the new
// status.
export function useDecideChatApproval(deploymentId?: string) {
  const queryClient = useQueryClient();
  const target = resolveTarget(deploymentId);
  return useMutation({
    mutationFn: async (input: {
      id: string;
      decision: "approve" | "reject";
      rejectionReason?: string;
    }) => approvalsApi.decide(input.id, input.decision, input.rejectionReason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: target.key });
    },
  });
}

// ── CEO-named wrappers (back-compat for the shell's CEO chat bubble) ───────

export function useCeoChatMessages(enabled: boolean) {
  return useChatMessages(undefined, enabled);
}
export function useSendCeoMessage() {
  return useSendChatMessage(undefined);
}
export function useClearCeoChat() {
  return useClearChat(undefined);
}
export function useDecideCeoApproval() {
  return useDecideChatApproval(undefined);
}

// Fallback shape for places that just want the raw query result and
// don't care about the mutation.
export function emptyMessages(): ListChatMessagesResponse {
  return { messages: [] };
}
