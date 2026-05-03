"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Code2, Copy, Eye } from "lucide-react";

export type MarkdownViewMode = "preview" | "markdown";

const STORAGE_KEY = "occa_markdown_view_mode";

function readStoredMode(): MarkdownViewMode | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "preview" || v === "markdown" ? v : null;
}

export interface MarkdownViewerProps {
  content: string;
  /** Starting view when the user has no saved preference. Defaults to "preview". */
  defaultView?: MarkdownViewMode;
  className?: string;
  /**
   * When true, renders without the internal toolbar. Caller is expected to
   * pass `viewMode` explicitly and render their own controls.
   */
  hideToolbar?: boolean;
  viewMode?: MarkdownViewMode;
  onViewModeChange?: (mode: MarkdownViewMode) => void;
  /** Optional right-side content for the built-in toolbar. */
  toolbarRight?: ReactNode;
  /** Persist the chosen mode to localStorage. Default true. */
  rememberChoice?: boolean;
}

// Dark-theme element styles for react-markdown. Keeps things legible without
// pulling in @tailwindcss/typography — each element type gets a targeted
// className via the `components` override.
const mdComponents = {
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 className="text-lg font-bold tracking-tight text-white mt-4 mb-2 first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 className="text-base font-semibold tracking-tight text-white/90 mt-4 mb-2 first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="text-sm font-semibold text-white/85 mt-3 mb-1.5 first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }: { children?: ReactNode }) => (
    <h4 className="text-[13px] font-semibold text-white/80 mt-3 mb-1 first:mt-0">
      {children}
    </h4>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p className="text-sm text-white/75 leading-relaxed mb-3 last:mb-0">
      {children}
    </p>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="list-disc pl-5 mb-3 space-y-1 text-sm text-white/75 marker:text-white/30">
      {children}
    </ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="list-decimal pl-5 mb-3 space-y-1 text-sm text-white/75 marker:text-white/30">
      {children}
    </ol>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <li className="leading-relaxed">{children}</li>
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="border-l-2 border-white/15 pl-3 my-3 text-sm text-white/55 italic">
      {children}
    </blockquote>
  ),
  code: ({
    inline,
    children,
    className,
  }: {
    inline?: boolean;
    children?: ReactNode;
    className?: string;
  }) => {
    if (inline) {
      return (
        <code className="font-mono text-[12px] px-1 py-0.5 rounded bg-white/8 text-amber-200/90">
          {children}
        </code>
      );
    }
    return (
      <code className={`${className ?? ""} font-mono text-[12px] text-green-200/90 block`}>
        {children}
      </code>
    );
  },
  pre: ({ children }: { children?: ReactNode }) => (
    <pre className="mb-3 p-3 rounded-lg bg-black/40 border border-white/8 overflow-x-auto">
      {children}
    </pre>
  ),
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-300/90 underline underline-offset-2 hover:text-blue-200"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="border-white/10 my-4" />,
  table: ({ children }: { children?: ReactNode }) => (
    <div className="mb-3 overflow-x-auto">
      <table className="min-w-full text-sm border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: ReactNode }) => (
    <thead className="border-b border-white/15">{children}</thead>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th className="text-left px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/50">
      {children}
    </th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="px-2 py-1.5 text-white/75 border-b border-white/8">
      {children}
    </td>
  ),
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="font-semibold text-white/90">{children}</strong>
  ),
  em: ({ children }: { children?: ReactNode }) => (
    <em className="italic text-white/80">{children}</em>
  ),
};

export function MarkdownViewer({
  content,
  defaultView = "preview",
  className,
  hideToolbar,
  viewMode: controlledMode,
  onViewModeChange,
  toolbarRight,
  rememberChoice = true,
}: MarkdownViewerProps) {
  // Sticky preference: if the user has picked a mode before, reopen in that
  // mode. Fall back to `defaultView` otherwise.
  const [internalMode, setInternalMode] = useState<MarkdownViewMode>(() =>
    rememberChoice ? readStoredMode() ?? defaultView : defaultView,
  );
  const mode = controlledMode ?? internalMode;

  const setMode = useCallback(
    (next: MarkdownViewMode) => {
      if (rememberChoice && typeof window !== "undefined") {
        window.localStorage.setItem(STORAGE_KEY, next);
      }
      if (onViewModeChange) onViewModeChange(next);
      else setInternalMode(next);
    },
    [onViewModeChange, rememberChoice],
  );

  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
    } catch {
      /* clipboard not available — ignore */
    }
  }, [content]);

  // Clear the "Copied" confirmation after a short delay.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className={className}>
      {!hideToolbar && (
        <div className="flex items-center justify-between mb-3">
          <div
            className="inline-flex rounded-lg p-0.5 gap-0.5"
            style={{ background: "rgba(255,255,255,0.05)" }}
          >
            <button
              type="button"
              onClick={() => setMode("preview")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                mode === "preview"
                  ? "bg-white/12 text-white shadow-sm"
                  : "text-white/45 hover:text-white/75"
              }`}
              title="Preview rendered markdown"
            >
              <Eye className="size-3" />
              Preview
            </button>
            <button
              type="button"
              onClick={() => setMode("markdown")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                mode === "markdown"
                  ? "bg-white/12 text-white shadow-sm"
                  : "text-white/45 hover:text-white/75"
              }`}
              title="View raw markdown source"
            >
              <Code2 className="size-3" />
              Markdown
            </button>
          </div>

          <div className="flex items-center gap-2">
            {toolbarRight}
            <button
              type="button"
              onClick={() => void handleCopy()}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-all ${
                copied
                  ? "text-emerald-300 bg-emerald-500/10"
                  : "text-white/40 hover:text-white/70 hover:bg-white/5"
              }`}
              title="Copy to clipboard"
            >
              {copied ? (
                <>
                  <Check className="size-3" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="size-3" />
                  Copy
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {mode === "preview" ? (
        <div className="text-white/80 animate-in fade-in duration-150">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={
              mdComponents as React.ComponentProps<typeof ReactMarkdown>["components"]
            }
          >
            {content}
          </ReactMarkdown>
        </div>
      ) : (
        <pre className="whitespace-pre-wrap font-mono text-[12px] text-white/75 leading-relaxed animate-in fade-in duration-150">
          {content}
        </pre>
      )}
    </div>
  );
}
