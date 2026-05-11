"use client";

import { MarkdownViewer } from "../../../components/ui/markdown-viewer";
import { Modal } from "../../../components/ui/modal";
import type { DocumentDTO } from "../../../lib/api";

interface DocumentViewerModalProps {
  doc: DocumentDTO;
  open: boolean;
  onClose: () => void;
}

// Receives the doc directly from the list response — list endpoint
// already returns full content, so refetching by id was a wasted round
// trip. Modal itself is now opacity-fade only (no backdrop-filter), so
// MarkdownViewer can mount synchronously without defer hacks.
export function DocumentViewerModal({
  doc,
  open,
  onClose,
}: DocumentViewerModalProps) {
  const subtitle = `${doc.tags.length > 0 ? doc.tags.join(" · ") + " · " : ""}created ${new Date(doc.createdAt).toLocaleString()}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={doc.title}
      subtitle={subtitle}
      width="min(820px, 96vw)"
      maxHeight="min(80vh, 720px)"
    >
      <div className="p-4">
        <MarkdownViewer content={doc.content} />
      </div>
    </Modal>
  );
}
