"use client";

import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Modal } from "../../../components/ui/modal";
import { Select } from "../../../components/ui/select";
import type { BrainFileDTO } from "../../../lib/api";
import {
  useDeleteBrainFile,
  useUpdateBrainFile,
} from "../api/use-brain-mutations";

const VISIBILITY_OPTIONS = [
  { value: "all", label: "All agents — everyone in the company" },
  { value: "tier:head", label: "Heads + CEO — strategic intel" },
  { value: "ceo_only", label: "CEO only — sensitive owner context" },
];

interface BrainEditorModalProps {
  file: BrainFileDTO;
  open: boolean;
  onClose: () => void;
}

export function BrainEditorModal({
  file,
  open,
  onClose,
}: BrainEditorModalProps) {
  const [content, setContent] = useState(file.content);
  const [visibility, setVisibility] = useState<BrainFileDTO["visibility"]>(
    file.visibility,
  );
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateBrainFile();
  const remove = useDeleteBrainFile();

  // Reset when a different file is opened — modal stays mounted across
  // re-opens, so without this the previous file's content would linger.
  useEffect(() => {
    setContent(file.content);
    setVisibility(file.visibility);
    setError(null);
  }, [file.id, file.content, file.visibility]);

  const dirty =
    content !== file.content || visibility !== file.visibility;

  const handleSave = async () => {
    setError(null);
    try {
      await update.mutateAsync({
        id: file.id,
        updates: { content, visibility },
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete ${file.path}? This cannot be undone.`)) return;
    setError(null);
    try {
      await remove.mutateAsync(file.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const saving = update.isPending;
  const deleting = remove.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={file.path}
      subtitle={`${file.sizeBytes} bytes · visibility: ${file.visibility}`}
      width="min(720px, 94vw)"
      footer={
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <Button
            variant="danger"
            onClick={handleDelete}
            disabled={saving || deleting}
          >
            {deleting ? "Deleting…" : "Delete"}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={!dirty || saving || deleting}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <label className="flex flex-col gap-1 text-sm text-white/70">
          <span>Visibility</span>
          <Select
            value={visibility}
            onChange={(e) =>
              setVisibility(e.target.value as BrainFileDTO["visibility"])
            }
          >
            {VISIBILITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-white/70">
          <span>Content (markdown)</span>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={18}
            className="w-full resize-y rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-sm text-white outline-none focus:border-white/30"
            spellCheck={false}
          />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </Modal>
  );
}
