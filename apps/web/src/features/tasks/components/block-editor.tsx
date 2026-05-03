"use client";

import { type KeyboardEvent, useCallback, useRef, useState } from "react";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import type { ContentBlock } from "@occa/shared/types";
import { AgentResultCard } from "./agent-result-card";
import { BLOCK_TYPES, blockText, makeBlock } from "./_shared";

export function BlockEditor({
  blocks,
  onChange,
}: {
  blocks: ContentBlock[];
  onChange: (blocks: ContentBlock[]) => void;
}) {
  const [slashMenuIdx, setSlashMenuIdx] = useState<number | null>(null);
  const inputRefs = useRef<(HTMLElement | null)[]>([]);

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

  const insertBlock = useCallback(
    (afterIdx: number, type: ContentBlock["type"] = "paragraph") => {
      const next = [...blocks];
      next.splice(afterIdx + 1, 0, makeBlock(type));
      onChange(next);
      setSlashMenuIdx(null);
      setTimeout(() => inputRefs.current[afterIdx + 1]?.focus(), 30);
    },
    [blocks, onChange],
  );

  const removeBlock = useCallback(
    (idx: number) => {
      if (blocks.length === 1) {
        onChange([makeBlock("paragraph")]);
        return;
      }
      const next = blocks.filter((_, i) => i !== idx);
      onChange(next);
      setTimeout(() => inputRefs.current[Math.max(0, idx - 1)]?.focus(), 30);
    },
    [blocks, onChange],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>, idx: number) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        insertBlock(idx);
      } else if (e.key === "Backspace") {
        const text = blockText(blocks[idx]);
        if (!text) {
          e.preventDefault();
          removeBlock(idx);
        }
      } else if (e.key === "Escape") {
        setSlashMenuIdx(null);
      }
    },
    [blocks, insertBlock, removeBlock],
  );

  const handleInput = useCallback(
    (e: React.FormEvent<HTMLElement>, idx: number) => {
      const text = (e.currentTarget as HTMLElement).innerText;
      if (text.endsWith("/")) {
        setSlashMenuIdx(idx);
      } else {
        setSlashMenuIdx(null);
      }
      updateBlock(idx, { text } as Partial<ContentBlock>);
    },
    [updateBlock],
  );

  const selectBlockType = useCallback(
    (idx: number, type: ContentBlock["type"]) => {
      const text = blockText(blocks[idx]).replace(/\/$/, "");
      const newBlock = { ...makeBlock(type), text } as ContentBlock;
      onChange(blocks.map((b, i) => (i === idx ? newBlock : b)));
      setSlashMenuIdx(null);
      setTimeout(() => inputRefs.current[idx]?.focus(), 30);
    },
    [blocks, onChange],
  );

  return (
    <div className="space-y-0.5">
      {blocks.map((block, idx) => (
        <BlockRow
          key={idx}
          block={block}
          idx={idx}
          showSlashMenu={slashMenuIdx === idx}
          inputRef={(el) => {
            inputRefs.current[idx] = el;
          }}
          onKeyDown={(e) => handleKeyDown(e, idx)}
          onInput={(e) => handleInput(e, idx)}
          onToggleCheck={() =>
            block.type === "checklist" &&
            updateBlock(idx, { checked: !block.checked } as Partial<ContentBlock>)
          }
          onRemove={() => removeBlock(idx)}
          onSelectType={(type) => selectBlockType(idx, type)}
          onAddBelow={() => insertBlock(idx)}
        />
      ))}
    </div>
  );
}

function BlockRow({
  block,
  showSlashMenu,
  inputRef,
  onKeyDown,
  onInput,
  onToggleCheck,
  onRemove,
  onSelectType,
  onAddBelow,
}: {
  block: ContentBlock;
  idx: number;
  showSlashMenu: boolean;
  inputRef: (el: HTMLElement | null) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  onInput: (e: React.FormEvent<HTMLElement>) => void;
  onToggleCheck: () => void;
  onRemove: () => void;
  onSelectType: (type: ContentBlock["type"]) => void;
  onAddBelow: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  const editableProps = {
    contentEditable: true as const,
    suppressContentEditableWarning: true,
    onKeyDown,
    onInput,
    ref: inputRef,
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
        data-placeholder="Write something, or type / for commands…"
        className={`${editableProps.className} text-sm text-white/80`}
        dangerouslySetInnerHTML={{ __html: block.text }}
      />
    );
  };

  return (
    <div
      className="group relative flex items-start gap-1 px-1 py-0.5 rounded-lg hover:bg-white/3 transition-colors"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={`flex flex-col items-center gap-0.5 pt-0.5 transition-opacity ${hovered ? "opacity-100" : "opacity-0"}`}
      >
        <button
          onClick={onAddBelow}
          className="p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors"
        >
          <Plus className="size-3" />
        </button>
        <GripVertical className="size-3 text-white/20 cursor-grab" />
      </div>

      <div className="flex-1 min-w-0">{renderBlock()}</div>

      {hovered && block.type !== "divider" && (
        <button
          onClick={onRemove}
          className="p-0.5 rounded hover:bg-white/10 text-white/20 hover:text-red-400 transition-colors shrink-0 mt-0.5"
        >
          <Trash2 className="size-3" />
        </button>
      )}

      {showSlashMenu && (
        <div className="absolute left-8 top-7 z-50 glass rounded-xl border border-white/10 p-1 w-44">
          {BLOCK_TYPES.map((bt) => (
            <button
              key={bt.type}
              onClick={() => onSelectType(bt.type)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-white/70 hover:bg-white/10 hover:text-white transition-colors"
            >
              <span className="text-white/40">{bt.icon}</span>
              {bt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
