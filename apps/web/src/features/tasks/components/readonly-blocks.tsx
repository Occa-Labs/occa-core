"use client";

import type { ContentBlock } from "@occa/shared/types";
import { MarkdownViewer } from "@/components/ui/markdown-viewer";
import { AgentResultCard } from "./agent-result-card";

// Read-only block renderer used by system tasks (which can't be edited
// by users — their content is authored by the worker / kickoff service).
// Mirrors BlockEditor's render branches but without contentEditable or
// hover affordances.
export function ReadOnlyBlocks({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <div className="space-y-1">
      {blocks.map((block, idx) => {
        if (block.type === "divider")
          return <hr key={idx} className="border-white/10 my-1" />;
        if (block.type === "agent_result")
          return <AgentResultCard key={idx} block={block} />;
        if (block.type === "heading_1")
          return (
            <h1
              key={idx}
              className="text-xl font-bold tracking-tight text-white/90"
            >
              {block.text}
            </h1>
          );
        if (block.type === "heading_2")
          return (
            <h2
              key={idx}
              className="text-base font-semibold tracking-tight text-white/80"
            >
              {block.text}
            </h2>
          );
        if (block.type === "heading_3")
          return (
            <h3 key={idx} className="text-sm font-semibold text-white/70">
              {block.text}
            </h3>
          );
        if (block.type === "bullet")
          return (
            <div
              key={idx}
              className="flex items-start gap-2 text-sm text-white/70"
            >
              <span className="mt-1.5 size-1.5 rounded-full bg-white/40 shrink-0" />
              <span>{block.text}</span>
            </div>
          );
        if (block.type === "checklist")
          return (
            <div key={idx} className="flex items-start gap-2 text-sm">
              <span
                className={`mt-0.5 size-4 rounded shrink-0 border flex items-center justify-center ${
                  block.checked
                    ? "bg-green-500/80 border-green-500"
                    : "border-white/20"
                }`}
              >
                {block.checked && (
                  <svg className="size-2.5" viewBox="0 0 10 8" fill="none">
                    <path
                      d="M1 4l3 3 5-6"
                      stroke="white"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
              <span
                className={
                  block.checked ? "line-through text-white/40" : "text-white/70"
                }
              >
                {block.text}
              </span>
            </div>
          );
        if (block.type === "quote")
          return (
            <div key={idx} className="flex gap-2">
              <div className="w-0.5 rounded-full bg-white/20 shrink-0" />
              <div className="text-white/60 italic text-sm">{block.text}</div>
            </div>
          );
        if (block.type === "code")
          return (
            <div key={idx} className="glass-light rounded-lg p-3">
              <pre className="font-mono text-xs text-green-300 whitespace-pre-wrap">
                {block.text}
              </pre>
            </div>
          );
        // Paragraph blocks frequently carry full markdown — the workflow
        // content-passing dumps a complete markdown deliverable (headings,
        // lists, bold, tables) into a single block, and routine mandates are
        // long prose with manual line breaks. Render through the markdown
        // viewer so structure reads cleanly. Markdown collapses single
        // newlines, so convert each lone newline to a hard break first to
        // keep the author's line breaks (paragraph breaks already survive).
        if (!block.text.trim()) return null;
        return (
          <MarkdownViewer
            key={idx}
            content={block.text.replace(/(?<!\n)\n(?!\n)/g, "  \n")}
            hideToolbar
            viewMode="preview"
          />
        );
      })}
    </div>
  );
}
