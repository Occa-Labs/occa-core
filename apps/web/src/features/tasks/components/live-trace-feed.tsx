"use client";

import { Loader2 } from "lucide-react";
import { useTraceStream, type TraceFrame } from "@/hooks/use-trace-stream";

// Live SSE feed for an in-flight task trace. Mounts inside TaskDetail
// only while the task is `in_progress`; collapses assistant token deltas
// into a single "Responding…" step so the feed doesn't explode for
// long replies. Tool / command / lifecycle events get their own row.

interface FeedStep {
  id: string;
  kind: "lifecycle" | "tool" | "command" | "assistant" | "error";
  label: string;
  detail?: string;
  active?: boolean;
  done?: boolean;
}

// Reduce a TraceFrame into a FeedStep. Collapses consecutive assistant
// deltas into a single "Responding…" step so the feed doesn't grow
// unbounded.
function frameToStep(frame: TraceFrame): FeedStep | null {
  const id = `${frame.eventType}-${frame.seq}`;

  if (frame.eventType === "lifecycle") {
    if (frame.phase === "started") {
      return { id, kind: "lifecycle", label: "Started", done: true };
    }
    if (frame.phase === "completed") {
      return { id, kind: "lifecycle", label: "Completed", done: true };
    }
    return {
      id,
      kind: "error",
      label: "Failed",
      detail: frame.error,
      done: true,
    };
  }

  const d = frame.payload ?? {};
  const stream = frame.stream ?? "";

  if (stream === "tool_call") {
    const name =
      typeof d.name === "string"
        ? d.name
        : typeof d.toolName === "string"
          ? d.toolName
          : typeof d.tool === "string"
            ? d.tool
            : "Tool";
    let detail: string | undefined;
    if (typeof d.input === "string") detail = d.input.slice(0, 120);
    else if (d.input && typeof d.input === "object") {
      const first = Object.values(d.input as Record<string, unknown>)[0];
      detail =
        typeof first === "string"
          ? first.slice(0, 120)
          : JSON.stringify(d.input).slice(0, 120);
    }
    return { id, kind: "tool", label: name, detail, active: true };
  }

  if (stream === "command") {
    const cmd =
      typeof d.command === "string"
        ? d.command
        : typeof d.cmd === "string"
          ? d.cmd
          : "";
    return {
      id,
      kind: "command",
      label: "Shell",
      detail: cmd.slice(0, 120) || undefined,
      active: true,
    };
  }

  if (stream === "error") {
    const msg =
      typeof d.error === "string"
        ? d.error
        : typeof d.message === "string"
          ? d.message
          : "Error";
    return { id, kind: "error", label: msg, done: true };
  }

  // assistant deltas collapsed in the caller; individual deltas return null.
  return null;
}

export function LiveTraceFeed({
  traceId,
  onFinish,
}: {
  traceId: string;
  onFinish: () => void;
}) {
  const { frames, connected } = useTraceStream(traceId, {
    onFinish: () => onFinish(),
  });

  // Assistant deltas → one "Responding…" step. Bookkeeping kept
  // in-render, no extra state needed since `frames` is append-only.
  const steps: FeedStep[] = [];
  let hasResponding = false;
  let respondingCharCount = 0;
  for (const frame of frames) {
    if (frame.eventType === "stream" && frame.stream === "assistant") {
      const p = frame.payload ?? {};
      const delta =
        typeof p.delta === "string"
          ? p.delta
          : typeof p.text === "string"
            ? p.text
            : "";
      if (delta) {
        respondingCharCount += delta.length;
        if (!hasResponding) {
          hasResponding = true;
          steps.push({
            id: "responding",
            kind: "assistant",
            label: "Responding…",
            active: true,
          });
        }
      }
      continue;
    }
    const step = frameToStep(frame);
    if (step) steps.push(step);
  }

  // Mark prior steps as done once a new one starts — only the last is
  // "active".
  for (let i = 0; i < steps.length - 1; i++) {
    if (steps[i].active) {
      steps[i] = { ...steps[i], active: false, done: true };
    }
  }

  if (steps.length === 0) {
    return (
      <div className="px-5 py-3 border-b border-white/8 bg-blue-500/5">
        <div className="flex items-center gap-2 text-[11px] text-white/40">
          <Loader2 className="size-3 animate-spin" />
          {connected ? "Waiting for agent…" : "Connecting…"}
        </div>
      </div>
    );
  }

  return (
    <div className="px-5 py-3 border-b border-white/8 bg-blue-500/5 space-y-1.5">
      {steps.map((step) => (
        <div key={step.id} className="flex items-start gap-2 text-[11px]">
          <div className="mt-1 shrink-0">
            {step.active ? (
              <div className="relative flex items-center justify-center size-3">
                <div className="absolute size-3 rounded-full bg-blue-400/20 animate-ping" />
                <div className="size-1.5 rounded-full bg-blue-300 z-10" />
              </div>
            ) : step.kind === "error" ? (
              <div className="size-2 rounded-full bg-red-400/80 mt-0.5" />
            ) : step.done ? (
              <div className="size-2 rounded-full bg-emerald-400/70 mt-0.5" />
            ) : (
              <div className="size-2 rounded-full bg-white/25 mt-0.5" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div
              className={
                step.kind === "error"
                  ? "text-red-300/80"
                  : step.active
                    ? "text-white/70"
                    : "text-white/40"
              }
            >
              {step.label}
              {step.kind === "assistant" && respondingCharCount > 0 && (
                <span className="text-white/30 ml-1">
                  · {respondingCharCount} chars
                </span>
              )}
            </div>
            {step.detail && (
              <div className="text-white/30 truncate font-mono text-[10px] mt-0.5">
                {step.detail}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
