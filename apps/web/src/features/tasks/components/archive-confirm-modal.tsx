"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";

// Lightweight confirm dialog for the archive action. Reason is optional
// — captured at archive time for context (shown in timeline + on the
// archived card chip), not validated.
export function ArchiveConfirmModal({
  taskNumber,
  open,
  pending,
  onCancel,
  onConfirm,
}: {
  taskNumber: number;
  open: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string | undefined) => void;
}) {
  const [reason, setReason] = useState("");
  const handleConfirm = () => {
    const trimmed = reason.trim();
    onConfirm(trimmed === "" ? undefined : trimmed);
  };
  const handleCancel = () => {
    if (pending) return;
    setReason("");
    onCancel();
  };
  return (
    <Modal
      open={open}
      onClose={handleCancel}
      title="Archive task"
      width="min(440px, 92vw)"
      zIndex={400}
      footer={
        <div className="flex justify-end gap-2 px-5 py-3">
          <button
            type="button"
            onClick={handleCancel}
            disabled={pending}
            className="px-3 py-1.5 rounded-lg text-xs text-white/40 hover:bg-white/8 disabled:opacity-40 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={pending}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/15 text-white/80 disabled:opacity-40 transition-colors"
          >
            {pending ? "Archiving…" : "Archive"}
          </button>
        </div>
      }
    >
      <div className="px-5 py-4 space-y-3">
        <p className="text-sm text-white/80">
          Archive Task #{taskNumber} as unresolved?
        </p>
        <div className="space-y-1.5">
          <label className="text-xs text-white/40">Reason (optional)</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. wrong agent, no engineer available"
            rows={3}
            className="w-full glass-light rounded-xl px-3 py-2 text-xs text-white/80 outline-none placeholder:text-white/30 focus:ring-1 focus:ring-white/20 resize-none leading-relaxed"
          />
        </div>
        <p className="text-[10px] text-white/30">
          Tasks can be unarchived later from the &quot;Show archived&quot;
          toggle.
        </p>
      </div>
    </Modal>
  );
}
