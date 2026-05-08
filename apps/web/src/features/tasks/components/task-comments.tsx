"use client";

// Slack-style comment thread. Comments flow chronologically top→bottom,
// composer pinned at the bottom. @mention completion fires when the user
// types `@` and resolves against the company's agent list — picking a
// suggestion inserts `@<name> ` (with trailing space) into the body.
//
// Server side resolves `@<name>` tokens to deployment ids and wakes the
// mentioned agents on POST. Mentions on incoming agent comments are
// already pre-resolved in `mentions[]` + `mentionNames[]` so this
// component only needs to render — no parsing.

import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useMemo,
  useRef,
  useState,
} from "react";
import { Send, Sparkles } from "lucide-react";
import type { TaskCommentDTO } from "@occa/shared/types";
import { useCreateTaskComment } from "../api/use-create-task-comment";
import { useTaskComments } from "../api/use-task-comments";

interface AgentRef {
  id: string;
  name: string;
}

export function TaskComments({
  taskId,
  agentList,
}: {
  taskId: string;
  agentList?: AgentRef[];
}) {
  const commentsQuery = useTaskComments(taskId);
  const createComment = useCreateTaskComment(taskId);
  const [body, setBody] = useState("");
  const [mentionState, setMentionState] = useState<{
    open: boolean;
    query: string;
    anchor: number;
  }>({ open: false, query: "", anchor: 0 });
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const comments = commentsQuery.data ?? [];
  const isPending = createComment.isPending;

  const mentionMatches = useMemo(() => {
    if (!mentionState.open || !agentList) return [];
    const q = mentionState.query.toLowerCase();
    return agentList
      .filter((a) => a.name.toLowerCase().includes(q))
      .slice(0, 5);
  }, [mentionState, agentList]);

  const insertMention = (name: string) => {
    const before = body.slice(0, mentionState.anchor);
    const afterToken = body.slice(mentionState.anchor + 1 + mentionState.query.length);
    const next = `${before}@${name} ${afterToken}`;
    setBody(next);
    setMentionState({ open: false, query: "", anchor: 0 });
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      const caret = before.length + name.length + 2;
      ta.focus();
      ta.setSelectionRange(caret, caret);
    });
  };

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setBody(value);
    const caret = e.target.selectionStart;
    // Find the last `@` before the caret with no whitespace between it
    // and the caret — that's the active mention token.
    const slice = value.slice(0, caret);
    const at = slice.lastIndexOf("@");
    if (at === -1) {
      setMentionState({ open: false, query: "", anchor: 0 });
      return;
    }
    const between = slice.slice(at + 1);
    if (/\s/.test(between)) {
      setMentionState({ open: false, query: "", anchor: 0 });
      return;
    }
    setMentionState({ open: true, query: between, anchor: at });
    setMentionIndex(0);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionState.open && mentionMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex(
          (i) => (i - 1 + mentionMatches.length) % mentionMatches.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(mentionMatches[mentionIndex]!.name);
        return;
      }
      if (e.key === "Escape") {
        setMentionState({ open: false, query: "", anchor: 0 });
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  const submit = async () => {
    const trimmed = body.trim();
    if (trimmed === "" || isPending) return;
    try {
      await createComment.mutateAsync(trimmed);
      setBody("");
      setMentionState({ open: false, query: "", anchor: 0 });
    } catch {
      // error surfaces via createComment.isError; user can retry
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h3 className="text-xs font-medium text-white/60">Comments</h3>
        {comments.length > 0 && (
          <span className="text-[10px] text-white/30">{comments.length}</span>
        )}
      </div>

      {comments.length === 0 && !commentsQuery.isPending ? (
        <p className="text-xs text-white/30 italic">
          No comments yet. @mention an agent to start a conversation.
        </p>
      ) : (
        <ul className="space-y-3">
          {comments.map((c) => (
            <li key={c.id}>
              <CommentRow comment={c} />
            </li>
          ))}
        </ul>
      )}

      <div className="relative pt-1">
        {mentionState.open && mentionMatches.length > 0 && (
          <div className="absolute left-0 right-0 -top-2 -translate-y-full glass rounded-xl border border-white/10 overflow-hidden shadow-lg z-20">
            {mentionMatches.map((m, i) => (
              <button
                key={m.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(m.name);
                }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${
                  i === mentionIndex
                    ? "bg-white/10 text-white"
                    : "text-white/70 hover:bg-white/5"
                }`}
              >
                <Sparkles className="size-3 text-blue-300/70" />
                {m.name}
              </button>
            ))}
          </div>
        )}

        <div className="glass-light rounded-xl px-3 py-2 focus-within:ring-1 focus-within:ring-white/20 transition-shadow">
          <textarea
            ref={textareaRef}
            value={body}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Reply… (@ to mention an agent, ⌘↵ to send)"
            rows={2}
            className="w-full bg-transparent text-xs text-white/85 outline-none placeholder:text-white/30 resize-none leading-relaxed field-sizing-content"
          />
          <div className="flex items-center justify-end gap-2 pt-1">
            {createComment.isError && (
              <span className="text-[10px] text-red-400/80">
                Failed to post — try again
              </span>
            )}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={body.trim() === "" || isPending}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/15 text-white/85 disabled:opacity-40 transition-colors"
            >
              <Send className="size-3" />
              {isPending ? "Posting…" : "Post"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CommentRow({ comment }: { comment: TaskCommentDTO }) {
  const isAgent = comment.authorAgentId !== null;
  const authorName = isAgent
    ? (comment.authorAgentName ?? "Agent")
    : "You";
  const time = formatCommentTime(comment.createdAt);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-1.5">
        {isAgent && <Sparkles className="size-3 text-blue-300/70" />}
        <span className="text-xs font-medium text-white/85">{authorName}</span>
        <span className="ml-auto text-[10px] text-white/30">{time}</span>
      </div>
      <p className="text-xs text-white/70 leading-relaxed whitespace-pre-wrap">
        {renderBodyWithMentions(comment.body, comment.mentionNames)}
      </p>
    </div>
  );
}

function renderBodyWithMentions(
  body: string,
  mentionNames: string[],
): ReactNode[] {
  if (mentionNames.length === 0) return [body];
  // Match `@<name>` for each known mention. Greedy-match longest first
  // so "Mira Chen" wins over "Mira" if both exist.
  const sorted = [...mentionNames].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`@(${escaped.join("|")})`, "g");
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;
  let key = 0;
  while ((match = regex.exec(body)) !== null) {
    if (match.index > lastIndex) {
      parts.push(body.slice(lastIndex, match.index));
    }
    parts.push(
      <span
        key={`m${key++}`}
        className="inline-block px-1 rounded bg-blue-400/15 text-blue-200/90"
      >
        @{match[1]}
      </span>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < body.length) parts.push(body.slice(lastIndex));
  return parts;
}

function formatCommentTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}
