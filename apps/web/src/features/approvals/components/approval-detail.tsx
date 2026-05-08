"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Check, Pencil, Undo2, X } from "lucide-react";
import type { AgentDTO, ApprovalDTO } from "@occa/shared/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MarkdownViewer } from "@/components/ui/markdown-viewer";
import { surface } from "@/components/ui/tokens";
import { cn } from "@/lib/utils";
import { useDecideApproval } from "../api/use-decide-approval";
import { useUpdateApproval } from "../api/use-update-approval";
import {
  MARKDOWN_PAYLOAD_KEYS,
  SYSTEM_PAYLOAD_KEYS,
  humanizeApprovalAction,
  relativeTime,
  stringifyPayloadValue,
} from "../utils";

interface ApprovalDetailProps {
  approval: ApprovalDTO;
  agentById: Map<string, AgentDTO>;
}

type DetailMode =
  | { kind: "view" }
  | { kind: "rejecting" }
  | { kind: "submitting" };

// Fields the user may edit before approving. Server enforces the same
// allowlist via Zod (PATCH /api/approvals/:id) so a client mutation
// can't sneak through extra keys.
const EDITABLE_FIELDS = ["title", "description", "acceptanceCriteria"] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

function readField(
  payload: Record<string, unknown>,
  key: EditableField,
): string {
  const v = payload[key];
  return typeof v === "string" ? v : "";
}

export function ApprovalDetail({ approval, agentById }: ApprovalDetailProps) {
  const decide = useDecideApproval();
  const update = useUpdateApproval();
  const [mode, setMode] = useState<DetailMode>({ kind: "view" });
  const [rejectReason, setRejectReason] = useState("");

  // Local form state mirrors editable payload fields. Re-seeded whenever
  // the underlying approval id changes (sidebar selection switch) so the
  // form always reflects the row's current values.
  const initial = {
    title: readField(approval.payload, "title"),
    description: readField(approval.payload, "description"),
    acceptanceCriteria: readField(approval.payload, "acceptanceCriteria"),
  };
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    setDraft({
      title: readField(approval.payload, "title"),
      description: readField(approval.payload, "description"),
      acceptanceCriteria: readField(approval.payload, "acceptanceCriteria"),
    });
    setMode({ kind: "view" });
    setRejectReason("");
  }, [approval.id, approval.payload]);

  const dirty =
    draft.title !== initial.title ||
    draft.description !== initial.description ||
    draft.acceptanceCriteria !== initial.acceptanceCriteria;

  const persistEditsIfDirty = useCallback(async (): Promise<boolean> => {
    if (!dirty) return true;
    try {
      await update.mutateAsync({
        id: approval.id,
        payload: {
          title: draft.title.trim() || undefined,
          description: draft.description.trim() || undefined,
          acceptanceCriteria: draft.acceptanceCriteria.trim() || null,
        },
      });
      return true;
    } catch {
      return false;
    }
  }, [approval.id, dirty, draft, update]);

  const handleApprove = useCallback(async () => {
    setMode({ kind: "submitting" });
    const saved = await persistEditsIfDirty();
    if (!saved) {
      setMode({ kind: "view" });
      return;
    }
    try {
      await decide.mutateAsync({ id: approval.id, decision: "approve" });
    } catch {
      setMode({ kind: "view" });
    }
  }, [approval.id, decide, persistEditsIfDirty]);

  const handleStartReject = useCallback(() => setMode({ kind: "rejecting" }), []);
  const handleCancelReject = useCallback(() => {
    setRejectReason("");
    setMode({ kind: "view" });
  }, []);

  const handleSendReject = useCallback(async () => {
    const reason = rejectReason.trim();
    if (!reason) return;
    setMode({ kind: "submitting" });
    try {
      await decide.mutateAsync({
        id: approval.id,
        decision: "reject",
        rejectionReason: reason,
      });
    } catch {
      setMode({ kind: "rejecting" });
    }
  }, [approval.id, decide, rejectReason]);

  const handleRevertEdits = useCallback(() => setDraft(initial), [initial]);

  const submitting = mode.kind === "submitting";
  const editing = dirty && mode.kind === "view";

  const agent = approval.requestedByAgentId
    ? agentById.get(approval.requestedByAgentId)
    : null;
  const agentName = agent?.name ?? "Agent";
  const agentRole = agent?.role ?? null;
  const actionLabel = humanizeApprovalAction(
    approval.actionType,
    approval.payload,
    agentById,
  );
  const wasEdited =
    typeof approval.payload === "object" &&
    approval.payload !== null &&
    "originalPayload" in (approval.payload as Record<string, unknown>);

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div className="flex items-start gap-3">
        <div
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/70"
          style={surface.recessed}
        >
          <Bot className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[14px] font-semibold text-white/90">
              {agentName}
            </span>
            {agentRole && (
              <span className="shrink-0 text-[11px] text-white/40">
                · {agentRole}
              </span>
            )}
            <span className="ml-auto shrink-0 text-[11px] text-white/40">
              {relativeTime(approval.requestedAt)}
            </span>
          </div>
          <div className="mt-0.5 text-[12px] text-white/60">{actionLabel}</div>
          {wasEdited && (
            <div className="mt-1 inline-flex items-center gap-1 text-[10px] text-amber-300/80">
              <Pencil className="h-3 w-3" />
              You edited this request before approving.
            </div>
          )}
        </div>
      </div>

      <EditableForm
        approval={approval}
        draft={draft}
        onChange={setDraft}
        disabled={submitting || mode.kind === "rejecting"}
      />

      {mode.kind === "rejecting" ? (
        <div className="space-y-2">
          <textarea
            autoFocus
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Reason for rejection…"
            rows={3}
            className={cn(
              "w-full resize-none rounded-lg border border-white/10",
              "bg-black/25 px-2.5 py-2 text-[12px] text-white/85",
              "placeholder:text-white/30 focus:border-white/25 focus:outline-none",
            )}
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancelReject}
              disabled={submitting}
            >
              <X className="size-3" />
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={submitting || rejectReason.trim().length === 0}
              onClick={handleSendReject}
            >
              {submitting ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          {editing && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRevertEdits}
              disabled={submitting}
            >
              <Undo2 className="size-3" />
              Revert edits
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleStartReject}
            disabled={submitting}
          >
            Reject
          </Button>
          <Button
            variant="success"
            size="sm"
            onClick={() => void handleApprove()}
            disabled={submitting}
          >
            <Check className="size-3" />
            {submitting
              ? "Approving…"
              : editing
                ? "Save & Approve"
                : "Approve"}
          </Button>
        </div>
      )}
    </div>
  );
}

interface EditableFormProps {
  approval: ApprovalDTO;
  draft: { title: string; description: string; acceptanceCriteria: string };
  onChange: (next: EditableFormProps["draft"]) => void;
  disabled: boolean;
}

function EditableForm({
  approval,
  draft,
  onChange,
  disabled,
}: EditableFormProps) {
  // Surface non-editable payload fields (targetAgentId, etc.) read-only
  // so the operator has full context when deciding.
  const readonlyEntries = Object.entries(approval.payload).filter(
    ([k]) =>
      !SYSTEM_PAYLOAD_KEYS.has(k) &&
      !(EDITABLE_FIELDS as readonly string[]).includes(k),
  );
  return (
    <Card variant="recessed" padding="md">
      <div className="flex flex-col gap-4 text-[12px]">
        <Field label="Title">
          <input
            type="text"
            value={draft.title}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, title: e.target.value })}
            className={inputClass}
          />
        </Field>
        <Field label="Description">
          <textarea
            value={draft.description}
            disabled={disabled}
            onChange={(e) =>
              onChange({ ...draft, description: e.target.value })
            }
            rows={5}
            className={cn(inputClass, "resize-y")}
          />
        </Field>
        <Field label="Acceptance criteria">
          <textarea
            value={draft.acceptanceCriteria}
            disabled={disabled}
            onChange={(e) =>
              onChange({ ...draft, acceptanceCriteria: e.target.value })
            }
            rows={3}
            placeholder="Optional"
            className={cn(inputClass, "resize-y")}
          />
        </Field>
        {readonlyEntries.map(([k, v]) => (
          <ReadOnlyField key={k} label={k} value={v} />
        ))}
      </div>
    </Card>
  );
}

const inputClass = cn(
  "w-full rounded-lg border border-white/10 bg-black/25",
  "px-2.5 py-2 text-[12px] text-white/85",
  "placeholder:text-white/30 focus:border-white/25 focus:outline-none",
  "disabled:cursor-not-allowed disabled:opacity-60",
);

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-white/35">
        {label}
      </span>
      {children}
    </div>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: unknown }) {
  const isMarkdown =
    MARKDOWN_PAYLOAD_KEYS.has(label) && typeof value === "string";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-white/35">
        {label}
      </span>
      {isMarkdown ? (
        <MarkdownViewer
          content={value as string}
          hideToolbar
          viewMode="preview"
          className="text-white/70"
        />
      ) : (
        <span className="wrap-break-word text-white/70">
          {stringifyPayloadValue(value)}
        </span>
      )}
    </div>
  );
}
