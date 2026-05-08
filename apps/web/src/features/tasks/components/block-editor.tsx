"use client";

// Stripped-down block editor. Renders existing blocks (created via the
// new-task description textarea or by agents) and lets the user edit
// text inline. No structural editing — block insertion / deletion /
// type-change all deferred until there's a real need. Keeps the surface
// small until block manipulation is actually used.
//
// Non-text blocks: divider renders as <hr>, agent_result delegates to
// AgentResultCard, checklist toggles via the checkbox button.

import { useCallback } from "react";
import type { ContentBlock } from "@occa/shared/types";
import { AgentResultCard } from "./agent-result-card";

export function BlockEditor({
  blocks,
  onChange,
}: {
  blocks: ContentBlock[];
  onChange: (blocks: ContentBlock[]) => void;
}) {
  const updateBlock = useCallback(
    (idx: number, updates: Partial<ContentBlock>) => {
      onChange(
        blocks.map((b, i) =>
          i === idx ? ({ ...b, ...updates } as ContentBlock) : b,
        ),
      );
    },
    [blocks, onChange],
  );

  return (
    <div className="space-y-0.5">
      {blocks.map((block, idx) => (
        <BlockRow
          key={idx}
          block={block}
          onInput={(e) =>
            updateBlock(idx, {
              text: (e.currentTarget as HTMLElement).innerText,
            } as Partial<ContentBlock>)
          }
          onToggleCheck={() =>
            block.type === "checklist" &&
            updateBlock(idx, { checked: !block.checked } as Partial<ContentBlock>)
          }
        />
      ))}
    </div>
  );
}

function BlockRow({
  block,
  onInput,
  onToggleCheck,
}: {
  block: ContentBlock;
  onInput: (e: React.FormEvent<HTMLElement>) => void;
  onToggleCheck: () => void;
}) {
  const editableProps = {
    contentEditable: true as const,
    suppressContentEditableWarning: true,
    onInput,
    spellCheck: false,
    className:
      "outline-none min-h-[1.5em] flex-1 empty:before:content-[attr(data-placeholder)] empty:before:text-white/20",
  };

  const renderBlock = () => {
    if (block.type === "divider") {
      return <hr className="border-white/10 my-1 w-full" />;
    }
    if (block.type === "agent_result") {
      return <AgentResultCard block={block} />;
    }
    if (block.type === "heading_1") {
      return (
        <h1
          {...editableProps}
          data-placeholder="Heading 1"
          className={`${editableProps.className} text-xl font-bold tracking-tight`}
          dangerouslySetInnerHTML={{ __html: block.text }}
        />
      );
    }
    if (block.type === "heading_2") {
      return (
        <h2
          {...editableProps}
          data-placeholder="Heading 2"
          className={`${editableProps.className} text-base font-semibold tracking-tight`}
          dangerouslySetInnerHTML={{ __html: block.text }}
        />
      );
    }
    if (block.type === "heading_3") {
      return (
        <h3
          {...editableProps}
          data-placeholder="Heading 3"
          className={`${editableProps.className} text-sm font-semibold`}
          dangerouslySetInnerHTML={{ __html: block.text }}
        />
      );
    }
    if (block.type === "bullet") {
      return (
        <div className="flex items-start gap-2">
          <span className="mt-1.5 size-1.5 rounded-full bg-white/40 shrink-0" />
          <div
            {...editableProps}
            data-placeholder="List item"
            dangerouslySetInnerHTML={{ __html: block.text }}
          />
        </div>
      );
    }
    if (block.type === "checklist") {
      return (
        <div className="flex items-start gap-2">
          <button
            onClick={onToggleCheck}
            className={`mt-0.5 size-4 rounded shrink-0 border flex items-center justify-center transition-colors ${
              block.checked
                ? "bg-green-500/80 border-green-500"
                : "border-white/20 hover:border-white/40"
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
          </button>
          <div
            {...editableProps}
            data-placeholder="Task item"
            className={`${editableProps.className} ${block.checked ? "line-through text-white/40" : ""}`}
            dangerouslySetInnerHTML={{ __html: block.text }}
          />
        </div>
      );
    }
    if (block.type === "quote") {
      return (
        <div className="flex gap-2">
          <div className="w-0.5 rounded-full bg-white/20 shrink-0" />
          <div
            {...editableProps}
            data-placeholder="Quote"
            className={`${editableProps.className} text-white/60 italic`}
            dangerouslySetInnerHTML={{ __html: block.text }}
          />
        </div>
      );
    }
    if (block.type === "code") {
      return (
        <div className="glass-light rounded-lg p-3">
          <pre>
            <code
              {...editableProps}
              data-placeholder="Code..."
              className={`${editableProps.className} font-mono text-xs text-green-300`}
              dangerouslySetInnerHTML={{ __html: block.text }}
            />
          </pre>
        </div>
      );
    }
    return (
      <div
        {...editableProps}
        data-placeholder="Write something…"
        className={`${editableProps.className} text-sm text-white/80`}
        dangerouslySetInnerHTML={{ __html: block.text }}
      />
    );
  };

  return (
    <div className="flex items-start gap-1 px-1 py-0.5">
      <div className="flex-1 min-w-0">{renderBlock()}</div>
    </div>
  );
}
