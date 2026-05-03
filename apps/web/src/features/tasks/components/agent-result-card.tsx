"use client";

import { useEffect, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { MarkdownViewer } from "@/components/ui/markdown-viewer";
import { tracesApi } from "@/lib/api";
import { stripOccaMarkers } from "@occa/shared/markers";
import type { ContentBlock } from "@occa/shared/types";
import { formatResultTimestamp } from "./_shared";

export function AgentResultCard({
  block,
}: {
  block: Extract<ContentBlock, { type: "agent_result" }>;
}) {
  const [open, setOpen] = useState(false);
  const [fullText, setFullText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || fullText !== null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    tracesApi
      .get(block.traceId)
      .then((res) => {
        if (cancelled) return;
        const raw =
          (res.trace.resultJson && typeof res.trace.resultJson.text === "string"
            ? (res.trace.resultJson.text as string)
            : null) ?? block.preview;
        // Backend strips markers on new traces; this handles legacy records
        // written before that fix landed.
        setFullText(stripOccaMarkers(raw));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, fullText, block.traceId, block.preview]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full text-left glass-light rounded-xl border border-white/10 hover:border-white/20 hover:bg-white/5 p-3 transition-colors group"
      >
        <div className="flex items-center gap-2 mb-1.5">
          <Sparkles className="size-3.5 text-blue-300/80" />
          <span className="text-[11px] font-medium text-white/80">
            {block.agentName}
          </span>
          <span className="text-[10px] text-white/30">
            · {formatResultTimestamp(block.timestamp)}
          </span>
          <span className="ml-auto text-[10px] text-white/30 group-hover:text-white/60 transition-colors">
            Click to expand
          </span>
        </div>
        <p className="text-xs text-white/60 leading-relaxed line-clamp-3">
          {block.preview}
        </p>
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        zIndex={300}
        widthClassName="max-w-2xl"
      >
        <div className="glass rounded-2xl border border-white/10 overflow-hidden flex flex-col max-h-[80vh]">
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/8">
            <div className="flex items-center gap-2">
              <Sparkles className="size-3.5 text-blue-300/80" />
              <span className="text-sm font-medium text-white/90">
                {block.agentName}
              </span>
              <span className="text-[11px] text-white/40">
                · {formatResultTimestamp(block.timestamp)}
              </span>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="p-1.5 rounded-lg hover:bg-white/10 text-white/40 transition-colors"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {loading && fullText === null ? (
              <div className="flex items-center gap-2 text-white/40 text-sm">
                <Loader2 className="size-3.5 animate-spin" />
                Loading result…
              </div>
            ) : error ? (
              <div className="text-sm text-red-300/80">
                Failed to load: {error}
              </div>
            ) : (
              <MarkdownViewer content={fullText ?? block.preview} />
            )}
          </div>
          <div className="px-5 py-2 border-t border-white/8 text-[10px] text-white/30 font-mono">
            trace {block.traceId.slice(0, 8)}
          </div>
        </div>
      </Modal>
    </>
  );
}
