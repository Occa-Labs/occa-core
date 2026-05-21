"use client";

// Compact markdown renderer tuned for chat bubble density — smaller
// fonts, tighter margins, and color-neutral element styles so it
// inherits the wrapping bubble's text color (sky for the viewer side,
// neutral for the partner side, etc.).
//
// Distinct from `MarkdownViewer`, which is the heavyweight surface for
// full-pane content (task descriptions, brain files, docs). Bubble
// rendering omits the toolbar, code-copy, and view-mode toggle, and
// scales heading/list sizes down to fit beside a 12-13px body.

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const bubbleMdComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mt-1 mb-1 text-[13px] font-semibold first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-1 mb-1 text-[12.5px] font-semibold first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-1 mb-1 text-[12px] font-semibold first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-1 mb-0.5 text-[12px] font-semibold first:mt-0">
      {children}
    </h4>
  ),
  p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="mb-1.5 list-disc space-y-0.5 pl-4 last:mb-0 marker:text-current/40">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-1.5 list-decimal space-y-0.5 pl-4 last:mb-0 marker:text-current/40">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-snug">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-current/20 pl-2 italic opacity-80">
      {children}
    </blockquote>
  ),
  code: ({ children, className }) => {
    const isBlock = (className ?? "").includes("language-");
    if (isBlock) {
      return (
        <code className={`${className ?? ""} block font-mono text-[11px]`}>
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-black/25 px-1 py-px font-mono text-[11px]">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-1.5 overflow-x-auto rounded-md bg-black/30 p-2 last:mb-0">
      {children}
    </pre>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-2 border-current/15" />,
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
};

export function BubbleMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={bubbleMdComponents}>
      {content}
    </ReactMarkdown>
  );
}
