"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  SendHorizontal,
  X,
} from "lucide-react";
import { ApiError, agentsApi } from "@/lib/api";
import { formatRoleLabel } from "@/lib/format-role";
import type { AgentDTO } from "@occa/shared/types";

interface LocalMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  // Steps captured during this message's generation — kept for expand/collapse
  traceSteps?: TraceStep[];
  elapsedSec?: number;
  error?: string;
}

interface TraceStep {
  id: string;
  kind: "start" | "tool" | "command" | "responding" | "done" | "error";
  label: string;
  detail?: string;
  active?: boolean;
}

function stepDot(step: TraceStep) {
  if (step.active)
    return (
      <div className="relative flex items-center justify-center size-3">
        <div className="absolute size-3 rounded-full bg-white/10 animate-ping" />
        <div className="size-1.5 rounded-full bg-white/50 z-10" />
      </div>
    );
  if (step.kind === "done")
    return <div className="size-2 rounded-full bg-emerald-400/80" />;
  if (step.kind === "error")
    return <div className="size-2 rounded-full bg-red-400/80" />;
  return <div className="size-2 rounded-full bg-white/20" />;
}

function stepLabel(step: TraceStep) {
  if (step.kind === "done") return "text-emerald-300/70";
  if (step.kind === "error") return "text-red-300/70";
  if (step.active) return "text-white/60";
  return "text-white/35";
}

// Inline trace — bullet-and-line timeline, Claude Code style.
// While running: steps appear live. After done: collapses to a pill summary.
function InlineTrace({
  steps,
  running,
  elapsedSec,
}: {
  steps: TraceStep[];
  running: boolean;
  elapsedSec: number;
}) {
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (!running && steps.length > 0) {
      const t = setTimeout(() => setExpanded(false), 2500);
      return () => clearTimeout(t);
    }
  }, [running, steps.length]);

  if (steps.length === 0) return null;

  // ── Collapsed pill ──
  if (!expanded) {
    const toolCount = steps.filter(
      (s) => s.kind === "tool" || s.kind === "command",
    ).length;
    return (
      <button
        onClick={() => setExpanded(true)}
        className="flex items-center gap-1.5 mb-2 px-2.5 py-1 rounded-full hover:bg-white/6 transition-colors group"
        style={{
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <CheckCircle2 className="size-2.5 text-emerald-400/60 shrink-0" />
        <span className="text-[10px] text-white/28 group-hover:text-white/48 transition-colors">
          {elapsedSec > 0 ? `${elapsedSec.toFixed(1)}s` : "Done"}
          {toolCount > 0
            ? ` · ${toolCount} tool${toolCount > 1 ? "s" : ""}`
            : ""}
        </span>
        <ChevronRight className="size-2.5 text-white/18 group-hover:text-white/38 transition-colors" />
      </button>
    );
  }

  // ── Expanded: bullet + line timeline ──
  return (
    <div className="mb-2">
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1;
        return (
          <div key={step.id} className="flex gap-2.5">
            {/* Left column: dot + connecting line */}
            <div
              className="flex flex-col items-center shrink-0"
              style={{ width: 10 }}
            >
              {/* mt aligns dot center with text center: (leading-4=16px - dot=8px) / 2 = 4px */}
              <div className="mt-1 shrink-0">{stepDot(step)}</div>
              {!isLast && (
                <div
                  className="w-px flex-1 mt-1"
                  style={{
                    background: "rgba(255,255,255,0.08)",
                    minHeight: 12,
                  }}
                />
              )}
            </div>

            {/* Content — leading-4 matches dot offset calc */}
            <div className={`min-w-0 ${isLast ? "pb-0" : "pb-2"}`}>
              <span className={`text-[11px] leading-4 ${stepLabel(step)}`}>
                {step.label}
              </span>
              {step.detail && (
                <span className="ml-2 text-[10px] text-white/18 font-mono truncate max-w-55 inline-block align-middle">
                  {step.detail}
                </span>
              )}
            </div>
          </div>
        );
      })}

      {!running && (
        <button
          onClick={() => setExpanded(false)}
          className="flex items-center gap-1 mt-1 ml-5.5 text-[10px] text-white/18 hover:text-white/38 transition-colors"
        >
          <ChevronDown className="size-2.5 rotate-180" />
          hide
        </button>
      )}
    </div>
  );
}

export function ChatModal({
  agent,
  onClose,
}: {
  agent: AgentDTO;
  onClose: () => void;
}) {
  // Persist conversationId per agent so gateway keeps the same session across modal opens
  const conversationId = useMemo(() => {
    const key = `occa_conv_${agent.id}`;
    const stored =
      typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    if (stored) return stored;
    const id = crypto.randomUUID();
    if (typeof window !== "undefined") window.localStorage.setItem(key, id);
    return id;
  }, [agent.id]);

  // Restore messages from localStorage on mount
  const [messages, setMessages] = useState<LocalMessage[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(`occa_chat_${agent.id}`);
      return raw ? (JSON.parse(raw) as LocalMessage[]) : [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // Live trace steps for the in-flight message (stored on the message after done)
  const [liveSteps, setLiveSteps] = useState<TraceStep[]>([]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamingIdRef = useRef<string | null>(null);
  const textBufRef = useRef("");
  const rafRef = useRef<number | null>(null);
  const respondingStepAddedRef = useRef(false);
  const startTimeRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Persist messages (skip in-flight streaming entries)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const toSave = messages.filter((m) => !m.streaming);
    try {
      window.localStorage.setItem(
        `occa_chat_${agent.id}`,
        JSON.stringify(toSave),
      );
    } catch {
      /* quota exceeded — ignore */
    }
  }, [agent.id, messages]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const addLiveStep = useCallback((step: Omit<TraceStep, "id">) => {
    setLiveSteps((prev) => {
      const updated = prev.map((s, i) =>
        i === prev.length - 1 ? { ...s, active: false } : s,
      );
      return [...updated, { ...step, id: crypto.randomUUID() }];
    });
  }, []);

  const flushStreamText = useCallback(() => {
    const id = streamingIdRef.current;
    if (!id) return;
    const content = textBufRef.current;
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, content } : m)),
    );
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", content: text },
    ]);
    setInput("");
    setSending(true);
    setLiveSteps([]);
    respondingStepAddedRef.current = false;
    startTimeRef.current = Date.now();

    const streamId = crypto.randomUUID();
    streamingIdRef.current = streamId;
    textBufRef.current = "";
    setMessages((prev) => [
      ...prev,
      { id: streamId, role: "assistant", content: "", streaming: true },
    ]);

    const abort = new AbortController();

    try {
      const reply = await agentsApi.chatStream(
        agent.id,
        text,
        conversationId,
        (evt) => {
          const d = evt.data;

          if (evt.stream === "assistant") {
            const delta =
              typeof d.delta === "string"
                ? d.delta
                : typeof d.text === "string"
                  ? d.text
                  : "";
            if (delta) {
              textBufRef.current += delta;
              if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
              rafRef.current = requestAnimationFrame(flushStreamText);
              if (!respondingStepAddedRef.current) {
                respondingStepAddedRef.current = true;
                addLiveStep({
                  kind: "responding",
                  label: "Responding…",
                  active: true,
                });
              }
            }
          } else if (evt.stream === "lifecycle") {
            const phase = (
              typeof d.phase === "string" ? d.phase : ""
            ).toLowerCase();
            const isDone =
              phase === "end" ||
              phase === "done" ||
              phase === "complete" ||
              phase === "finished";
            const isErr =
              phase === "error" || phase === "failed" || phase === "cancelled";
            addLiveStep({
              kind: isErr ? "error" : isDone ? "done" : "start",
              label: isErr
                ? `Failed: ${phase}`
                : isDone
                  ? "Done"
                  : phase.charAt(0).toUpperCase() + phase.slice(1),
              detail: typeof d.message === "string" ? d.message : undefined,
              active: !isDone && !isErr,
            });
          } else if (evt.stream === "tool_call") {
            const name =
              typeof d.name === "string"
                ? d.name
                : typeof d.toolName === "string"
                  ? d.toolName
                  : typeof d.tool === "string"
                    ? d.tool
                    : "Tool";
            let detail: string | undefined;
            if (typeof d.input === "string") {
              detail = d.input.slice(0, 100);
            } else if (d.input && typeof d.input === "object") {
              const first = Object.values(
                d.input as Record<string, unknown>,
              )[0];
              detail =
                typeof first === "string"
                  ? first.slice(0, 100)
                  : JSON.stringify(d.input).slice(0, 100);
            } else if (typeof d.args === "string") {
              detail = d.args.slice(0, 100);
            }
            addLiveStep({ kind: "tool", label: name, detail, active: true });
          } else if (evt.stream === "command") {
            const cmd =
              typeof d.command === "string"
                ? d.command
                : typeof d.cmd === "string"
                  ? d.cmd
                  : "";
            addLiveStep({
              kind: "command",
              label: "Shell",
              detail: cmd.slice(0, 100) || undefined,
              active: true,
            });
          } else if (evt.stream === "error") {
            const msg =
              typeof d.error === "string"
                ? d.error
                : typeof d.message === "string"
                  ? d.message
                  : "Error";
            addLiveStep({ kind: "error", label: msg });
          }
        },
        abort.signal,
      );

      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      const finalContent =
        reply.length >= textBufRef.current.length ? reply : textBufRef.current;
      const elapsedSec = (Date.now() - startTimeRef.current) / 1000;

      // Finalize steps (add done if missing), then attach to the message
      const finalSteps = await new Promise<TraceStep[]>((resolve) => {
        setLiveSteps((prev) => {
          const withDone =
            prev.length > 0 && prev[prev.length - 1].kind === "done"
              ? prev.map((s) => ({ ...s, active: false }))
              : [
                  ...prev.map((s) => ({ ...s, active: false })),
                  {
                    id: crypto.randomUUID(),
                    kind: "done" as const,
                    label: "Done",
                  },
                ];
          resolve(withDone);
          return withDone;
        });
      });

      setMessages((prev) =>
        prev.map((m) =>
          m.id === streamId
            ? {
                ...m,
                content: finalContent,
                streaming: false,
                traceSteps: finalSteps,
                elapsedSec,
              }
            : m,
        ),
      );
      streamingIdRef.current = null;
      setLiveSteps([]);
    } catch (e) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      streamingIdRef.current = null;
      if ((e as { name?: string }).name === "AbortError") {
        setMessages((prev) => prev.filter((m) => m.id !== streamId));
        return;
      }
      const errText =
        e instanceof ApiError
          ? ((e.body as { error?: string; reason?: string } | null)?.reason ??
            (e.body as { error?: string } | null)?.error ??
            `http_${e.status}`)
          : "network error";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === streamId
            ? { ...m, content: "", streaming: false, error: errText }
            : m,
        ),
      );
      addLiveStep({ kind: "error", label: errText });
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [agent.id, addLiveStep, conversationId, flushStreamText, input, sending]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    },
    [send],
  );

  const hasInput = input.trim().length > 0;

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col"
      style={{
        background: "rgba(12, 12, 16, 0.96)",
        backdropFilter: "blur(40px) saturate(1.8)",
        WebkitBackdropFilter: "blur(40px) saturate(1.8)",
      }}
    >
      {/* ── Header ── */}
      <div
        className="shrink-0 flex items-center gap-3 px-4 py-2.5"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="size-6 rounded-full shrink-0 flex items-center justify-center transition-colors hover:bg-white/12 active:bg-white/18"
          style={{ background: "rgba(255,255,255,0.07)" }}
        >
          <X className="size-3 text-white/45" />
        </button>
        <div className="flex-1 flex items-center justify-center gap-2 min-w-0">
          <span className="text-[13px] font-medium text-white/65 tracking-tight truncate">
            {agent.name}
          </span>
          <span
            className="shrink-0 text-[10px] text-white/28 px-1.5 py-0.5 rounded font-medium"
            style={{ background: "rgba(255,255,255,0.06)" }}
          >
            {formatRoleLabel(agent.role)}
          </span>
        </div>
        {/* Balance spacer */}
        <div className="size-3 shrink-0" />
      </div>

      {/* ── Messages ── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-4 pt-4 pb-16 space-y-2">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <div
                className="size-10 rounded-2xl flex items-center justify-center"
                style={{
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.07)",
                }}
              >
                <MessageSquare className="size-4 text-white/25" />
              </div>
              <p className="text-[13px] text-white/30 font-medium mt-1">
                {agent.name}
              </p>
              <p className="text-[11px] text-white/18 max-w-55 leading-relaxed">
                Start a conversation. The agent responds in real-time.
              </p>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
            >
              {msg.role === "assistant" && !msg.error && (
                <>
                  {msg.streaming && liveSteps.length > 0 && (
                    <InlineTrace
                      steps={liveSteps}
                      running={true}
                      elapsedSec={0}
                    />
                  )}
                  {!msg.streaming &&
                    msg.traceSteps &&
                    msg.traceSteps.length > 0 && (
                      <InlineTrace
                        steps={msg.traceSteps}
                        running={false}
                        elapsedSec={msg.elapsedSec ?? 0}
                      />
                    )}
                </>
              )}

              {msg.error ? (
                <div
                  className="max-w-[78%] flex items-start gap-2 rounded-2xl px-3.5 py-2.5"
                  style={{
                    background: "rgba(239,68,68,0.08)",
                    border: "1px solid rgba(239,68,68,0.14)",
                  }}
                >
                  <AlertCircle className="size-3 text-red-400/70 shrink-0 mt-0.5" />
                  <span className="text-[12px] text-red-300/65 leading-relaxed">
                    {msg.error}
                  </span>
                </div>
              ) : msg.role === "user" ? (
                <div
                  className="max-w-[78%] rounded-[18px] rounded-br-[5px] px-3.5 py-2 text-[13px] text-white leading-normal whitespace-pre-wrap wrap-break-word"
                  style={{
                    background:
                      "linear-gradient(150deg, #0A84FF 0%, #0070D8 100%)",
                  }}
                >
                  {msg.content}
                </div>
              ) : (
                <div
                  className="max-w-[78%] rounded-[18px] rounded-bl-[5px] px-3.5 py-2 text-[13px] text-white/75 leading-[1.6] whitespace-pre-wrap wrap-break-word"
                  style={{
                    background: "rgba(255,255,255,0.055)",
                    border: "1px solid rgba(255,255,255,0.07)",
                  }}
                >
                  {msg.streaming && !msg.content ? (
                    <span className="text-white/20 text-[12px]">Thinking…</span>
                  ) : (
                    msg.content
                  )}
                  {msg.streaming && (
                    <span className="inline-block w-0.5 h-3.25 rounded-full bg-white/35 ml-0.75 align-middle animate-pulse" />
                  )}
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* ── Input — floats over messages with a gradient fade ── */}
      <div
        className="shrink-0 px-4 pt-3 pb-4"
        style={{
          background:
            "linear-gradient(to top, rgba(12,12,16,0.98) 60%, rgba(12,12,16,0) 100%)",
          marginTop: "-32px",
        }}
      >
        <div
          className="flex items-end gap-2.5 rounded-2xl px-3.5 py-2.5 transition-all duration-150"
          style={{
            background: "rgba(255,255,255,0.055)",
            border: `1px solid rgba(255,255,255,${hasInput ? "0.11" : "0.065"})`,
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message…"
            rows={1}
            className="flex-1 resize-none bg-transparent text-[13px] text-white/82 placeholder:text-white/20 outline-none leading-relaxed max-h-32 overflow-y-auto py-0.5"
            style={{ fieldSizing: "content" } as React.CSSProperties}
            disabled={sending}
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || !hasInput}
            aria-label="Send"
            className="shrink-0 mb-0.5 flex items-center justify-center size-6 rounded-lg transition-all duration-150 disabled:opacity-25 disabled:cursor-not-allowed"
            style={{
              background:
                hasInput && !sending
                  ? "linear-gradient(150deg, #0A84FF 0%, #0070D8 100%)"
                  : "rgba(255,255,255,0.07)",
            }}
          >
            <SendHorizontal className="size-3 text-white/85" />
          </button>
        </div>
      </div>
    </div>
  );
}
