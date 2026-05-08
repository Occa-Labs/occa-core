"use client";

// Chip-based tags editor used by both new-task-modal and task-detail.
// Adds a tag on Enter or comma. Already-present tags are deduped
// silently. Used inside a `DetailField` so the placeholder switches when
// at least one tag exists, keeping the inline composer compact.

import { useState } from "react";
import { X } from "lucide-react";

export function TagsEditor({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [input, setInput] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-1 rounded-full glass-light px-2 py-0.5 text-[10px] text-white/60"
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(tags.filter((t) => t !== tag))}
            className="hover:text-red-400 transition-colors"
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === ",") && input.trim()) {
            e.preventDefault();
            const tag = input.trim().replace(/,/g, "");
            if (!tags.includes(tag)) onChange([...tags, tag]);
            setInput("");
          }
        }}
        placeholder={tags.length === 0 ? "Add tags…" : "+ tag"}
        className="bg-transparent text-[10px] text-white/60 placeholder:text-white/25 outline-none min-w-20 flex-1"
      />
    </div>
  );
}
