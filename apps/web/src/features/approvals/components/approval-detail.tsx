"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, Bot, Check, Pencil, Rocket, Undo2, X } from "lucide-react";
import type { AgentDTO, ApprovalDTO } from "@occa/shared/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MarkdownViewer } from "@/components/ui/markdown-viewer";
import { surface } from "@/components/ui/tokens";
import { cn } from "@/lib/utils";
import { useDecideApproval } from "../api/use-decide-approval";
import { useDismissApproval } from "../api/use-dismiss-approval";
import { useUpdateApproval } from "../api/use-update-approval";
import {
  MARKDOWN_PAYLOAD_KEYS,
  SYSTEM_PAYLOAD_KEYS,
  type DeployProposalRequest,
  approvalStatusLabel,
  humanizeApprovalAction,
  readDeployProposal,
  relativeTime,
  stringifyPayloadValue,
} from "../utils";

interface ApprovalDetailProps {
  approval: ApprovalDTO;
  agentById: Map<string, AgentDTO>;
  /** Bubbles a "Deploy this" click on a propose_deployment row up to the
   *  shell, which opens the pre-filled deploy modal. Absent for non-
   *  deployment approvals. */
  onDeployProposal?: (req: DeployProposalRequest) => void;
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

export function ApprovalDetail({
  approval,
  agentById,
  onDeployProposal,
}: ApprovalDetailProps) {
  // Decided approvals (History view) are immutable: render read-only with
  // a status badge, no action buttons, regardless of actionType.
  if (approval.status !== "pending") {
    return <DecidedApprovalDetail approval={approval} agentById={agentById} />;
  }

  // Deployment proposals get a dedicated read-only view + "Deploy this"
  // handoff — they are NOT task-shaped (no title/description/acceptance)
  // and approve must never provision (that's operator-signed in the
  // deploy modal). Branch before the editable-task machinery below.
  if (approval.actionType === "propose_deployment") {
    return (
      <ProposeDeploymentDetail
        approval={approval}
        agentById={agentById}
        onDeployProposal={onDeployProposal}
      />
    );
  }

  // Profile-edit proposals are not task-shaped (no title/description) and
  // the operator approves the CEO's draft as-is — no editable form. Approve
  // applies the patch via the with-approval engine.
  if (approval.actionType === "edit_company_profile") {
    return <ProfileEditDetail approval={approval} agentById={agentById} />;
  }

  // Knowledge-file edits (create/update/delete a Company Brain file) are not
  // task-shaped; approve runs the repo write via the with-approval engine.
  if (approval.actionType === "edit_knowledge") {
    return <KnowledgeEditDetail approval={approval} agentById={agentById} />;
  }

  // Routine edits (mandate edit / delete) — approve runs the repo write.
  if (approval.actionType === "edit_routine") {
    return <RoutineEditDetail approval={approval} agentById={agentById} />;
  }

  // Skill-library edits (set allowed-roles / remove) — approve runs the write.
  if (approval.actionType === "edit_skill_library") {
    return <SkillLibraryEditDetail approval={approval} agentById={agentById} />;
  }

  // Tool edits (set allowed-roles / status / delete) — approve runs the write.
  if (approval.actionType === "edit_tool") {
    return <ToolEditDetail approval={approval} agentById={agentById} />;
  }

  // Delete-only proposals (workflow, task) share one minimal view.
  if (approval.actionType === "delete_workflow") {
    return (
      <SimpleDeleteDetail approval={approval} agentById={agentById} noun="workflow" />
    );
  }
  if (approval.actionType === "delete_task") {
    return (
      <SimpleDeleteDetail approval={approval} agentById={agentById} noun="task" />
    );
  }

  // Workflow create / edit — approve runs the workflows-service write.
  if (
    approval.actionType === "create_workflow" ||
    approval.actionType === "edit_workflow"
  ) {
    return <WorkflowProposalDetail approval={approval} agentById={agentById} />;
  }

  return (
    <TaskApprovalDetail approval={approval} agentById={agentById} />
  );
}

// Quiet "clear from the queue" action shared by all three pending views.
// Sets the approval to "cancelled" via dismissApproval — no reason, no side
// effects — distinct from Reject (an explicit denial that records a reason).
// Self-contained: owns its mutation so each view just drops it next to
// Reject. The optimistic drop unmounts this detail almost immediately, so
// the in-flight window is tiny.
function DismissButton({
  approvalId,
  disabled,
}: {
  approvalId: string;
  disabled?: boolean;
}) {
  const dismiss = useDismissApproval();
  return (
    <Button
      variant="ghost"
      size="sm"
      title="Clear this from the queue without a decision"
      disabled={disabled || dismiss.isPending}
      onClick={() =>
        void dismiss.mutateAsync({ id: approvalId }).catch(() => {})
      }
    >
      <Archive className="size-3" />
      {dismiss.isPending ? "Dismissing…" : "Dismiss"}
    </Button>
  );
}

function TaskApprovalDetail({ approval, agentById }: ApprovalDetailProps) {
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
          <DismissButton approvalId={approval.id} disabled={submitting} />
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

// ── Deployment proposal view ─────────────────────────────────────────
// Read-only render of a CEO PROPOSE_DEPLOYMENT row. The primary action
// is "Deploy this" (bubbles to the shell to open the pre-filled deploy
// modal), NOT approve — approving never provisions an agent. Reject is
// still available to dismiss a bogus proposal.
function ProposeDeploymentDetail({
  approval,
  agentById,
  onDeployProposal,
}: {
  approval: ApprovalDTO;
  agentById: Map<string, AgentDTO>;
  onDeployProposal?: (req: DeployProposalRequest) => void;
}) {
  const decide = useDecideApproval();
  const [mode, setMode] = useState<DetailMode>({ kind: "view" });
  const [rejectReason, setRejectReason] = useState("");

  useEffect(() => {
    setMode({ kind: "view" });
    setRejectReason("");
  }, [approval.id]);

  const proposal = readDeployProposal(approval.id, approval.payload);
  const submitting = mode.kind === "submitting";

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

  const agent = approval.requestedByAgentId
    ? agentById.get(approval.requestedByAgentId)
    : null;
  const agentName = agent?.name ?? "CEO";
  const agentRole = agent?.role ?? null;
  const actionLabel = humanizeApprovalAction(
    approval.actionType,
    approval.payload,
    agentById,
  );

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
        </div>
      </div>

      <ProposalSummaryCard proposal={proposal} />

      <p className="text-[11px] leading-relaxed text-white/45">
        Approve doesn&apos;t deploy. Hit “Deploy this” to open the deploy form
        pre-filled with these choices — you enter the gateway endpoint + token
        and sign there. Nothing is provisioned until you do.
      </p>

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
              onClick={() => {
                setRejectReason("");
                setMode({ kind: "view" });
              }}
              disabled={submitting}
            >
              <X className="size-3" />
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={submitting || rejectReason.trim().length === 0}
              onClick={() => void handleSendReject()}
            >
              {submitting ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          <DismissButton approvalId={approval.id} disabled={submitting} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMode({ kind: "rejecting" })}
            disabled={submitting}
          >
            Reject
          </Button>
          <Button
            variant="success"
            size="sm"
            onClick={() => onDeployProposal?.(proposal)}
            disabled={submitting || !onDeployProposal}
          >
            <Rocket className="size-3" />
            Deploy this
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Profile edit proposal view ───────────────────────────────────────
// Read-only render of a CEO PROPOSE_PROFILE_EDIT row: the proposed profile
// fields, with a plain Approve that applies the patch (the with-approval
// engine runs the upsert on approve) and Reject. The operator approves the
// CEO's draft as-is or rejects — no inline editing in this v1.
function ProfileEditDetail({
  approval,
  agentById,
}: {
  approval: ApprovalDTO;
  agentById: Map<string, AgentDTO>;
}) {
  const decide = useDecideApproval();
  const [mode, setMode] = useState<DetailMode>({ kind: "view" });
  const [rejectReason, setRejectReason] = useState("");

  useEffect(() => {
    setMode({ kind: "view" });
    setRejectReason("");
  }, [approval.id]);

  const submitting = mode.kind === "submitting";

  const handleApprove = useCallback(async () => {
    setMode({ kind: "submitting" });
    try {
      await decide.mutateAsync({ id: approval.id, decision: "approve" });
    } catch {
      setMode({ kind: "view" });
    }
  }, [approval.id, decide]);

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

  const agent = approval.requestedByAgentId
    ? agentById.get(approval.requestedByAgentId)
    : null;
  const agentName = agent?.name ?? "CEO";
  const agentRole = agent?.role ?? null;
  const actionLabel = humanizeApprovalAction(
    approval.actionType,
    approval.payload,
    agentById,
  );
  const fields = Object.entries(approval.payload).filter(
    ([k]) => !SYSTEM_PAYLOAD_KEYS.has(k),
  );

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
        </div>
      </div>

      {fields.length > 0 && (
        <Card variant="recessed" padding="md">
          <div className="flex flex-col gap-4 text-[12px]">
            {fields.map(([k, v]) => (
              <ReadOnlyField key={k} label={k} value={v} />
            ))}
          </div>
        </Card>
      )}

      <p className="text-[11px] leading-relaxed text-white/45">
        Approving applies these changes to your company profile. The payout
        wallet is never part of a proposal — change it yourself in the Company
        window.
      </p>

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
              onClick={() => {
                setRejectReason("");
                setMode({ kind: "view" });
              }}
              disabled={submitting}
            >
              <X className="size-3" />
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={submitting || rejectReason.trim().length === 0}
              onClick={() => void handleSendReject()}
            >
              {submitting ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          <DismissButton approvalId={approval.id} disabled={submitting} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMode({ kind: "rejecting" })}
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
            {submitting ? "Approving…" : "Approve"}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Knowledge-file edit proposal view ────────────────────────────────
// Read-only render of a CEO PROPOSE_KNOWLEDGE_EDIT row (op + path + content
// + visibility). Approve runs the Company Brain repo write (create/update/
// delete) via the with-approval engine; Reject denies it; Dismiss clears it.
// No inline editing in this v1.
function KnowledgeEditDetail({
  approval,
  agentById,
}: {
  approval: ApprovalDTO;
  agentById: Map<string, AgentDTO>;
}) {
  const decide = useDecideApproval();
  const [mode, setMode] = useState<DetailMode>({ kind: "view" });
  const [rejectReason, setRejectReason] = useState("");

  useEffect(() => {
    setMode({ kind: "view" });
    setRejectReason("");
  }, [approval.id]);

  const submitting = mode.kind === "submitting";

  const handleApprove = useCallback(async () => {
    setMode({ kind: "submitting" });
    try {
      await decide.mutateAsync({ id: approval.id, decision: "approve" });
    } catch {
      setMode({ kind: "view" });
    }
  }, [approval.id, decide]);

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

  const agent = approval.requestedByAgentId
    ? agentById.get(approval.requestedByAgentId)
    : null;
  const agentName = agent?.name ?? "CEO";
  const agentRole = agent?.role ?? null;
  const actionLabel = humanizeApprovalAction(
    approval.actionType,
    approval.payload,
    agentById,
  );
  const op =
    typeof approval.payload.op === "string" ? approval.payload.op : "update";
  const fields = Object.entries(approval.payload).filter(
    ([k]) => !SYSTEM_PAYLOAD_KEYS.has(k),
  );

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
        </div>
      </div>

      {fields.length > 0 && (
        <Card variant="recessed" padding="md">
          <div className="flex flex-col gap-4 text-[12px]">
            {fields.map(([k, v]) => (
              <ReadOnlyField key={k} label={k} value={v} />
            ))}
          </div>
        </Card>
      )}

      <p className="text-[11px] leading-relaxed text-white/45">
        {op === "delete"
          ? "Approving permanently removes this knowledge file from the Company Brain."
          : op === "create"
            ? "Approving adds this file to the Company Brain. Content replaces nothing — it's a new file."
            : "Approving overwrites the file's content/visibility in the Company Brain with what's shown above."}
      </p>

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
              onClick={() => {
                setRejectReason("");
                setMode({ kind: "view" });
              }}
              disabled={submitting}
            >
              <X className="size-3" />
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={submitting || rejectReason.trim().length === 0}
              onClick={() => void handleSendReject()}
            >
              {submitting ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          <DismissButton approvalId={approval.id} disabled={submitting} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMode({ kind: "rejecting" })}
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
            {submitting ? "Approving…" : "Approve"}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Routine edit proposal view ───────────────────────────────────────
// Read-only render of a CEO PROPOSE_ROUTINE_EDIT row (op + routineId +
// mandate fields). Approve runs updateRoutine/deleteRoutine via the
// with-approval engine; Reject denies; Dismiss clears. No inline editing.
function RoutineEditDetail({
  approval,
  agentById,
}: {
  approval: ApprovalDTO;
  agentById: Map<string, AgentDTO>;
}) {
  const decide = useDecideApproval();
  const [mode, setMode] = useState<DetailMode>({ kind: "view" });
  const [rejectReason, setRejectReason] = useState("");

  useEffect(() => {
    setMode({ kind: "view" });
    setRejectReason("");
  }, [approval.id]);

  const submitting = mode.kind === "submitting";

  const handleApprove = useCallback(async () => {
    setMode({ kind: "submitting" });
    try {
      await decide.mutateAsync({ id: approval.id, decision: "approve" });
    } catch {
      setMode({ kind: "view" });
    }
  }, [approval.id, decide]);

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

  const agent = approval.requestedByAgentId
    ? agentById.get(approval.requestedByAgentId)
    : null;
  const agentName = agent?.name ?? "CEO";
  const agentRole = agent?.role ?? null;
  const actionLabel = humanizeApprovalAction(
    approval.actionType,
    approval.payload,
    agentById,
  );
  const op =
    typeof approval.payload.op === "string" ? approval.payload.op : "update";
  const fields = Object.entries(approval.payload).filter(
    ([k]) => !SYSTEM_PAYLOAD_KEYS.has(k),
  );

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
        </div>
      </div>

      {fields.length > 0 && (
        <Card variant="recessed" padding="md">
          <div className="flex flex-col gap-4 text-[12px]">
            {fields.map(([k, v]) => (
              <ReadOnlyField key={k} label={k} value={v} />
            ))}
          </div>
        </Card>
      )}

      <p className="text-[11px] leading-relaxed text-white/45">
        {op === "delete"
          ? "Approving permanently deletes this routine. Its triggers stop firing."
          : "Approving updates this routine's mandate. Schedule, assignee, and active/paused state are unchanged."}
      </p>

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
              onClick={() => {
                setRejectReason("");
                setMode({ kind: "view" });
              }}
              disabled={submitting}
            >
              <X className="size-3" />
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={submitting || rejectReason.trim().length === 0}
              onClick={() => void handleSendReject()}
            >
              {submitting ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          <DismissButton approvalId={approval.id} disabled={submitting} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMode({ kind: "rejecting" })}
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
            {submitting ? "Approving…" : "Approve"}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Skill-library edit proposal view ─────────────────────────────────
// Read-only render of a CEO PROPOSE_SKILL_LIBRARY_EDIT row (op + skillKey +
// allowedRoles). Approve runs updateSkillById/deleteSkillById via the
// with-approval engine; Reject denies; Dismiss clears.
function SkillLibraryEditDetail({
  approval,
  agentById,
}: {
  approval: ApprovalDTO;
  agentById: Map<string, AgentDTO>;
}) {
  const decide = useDecideApproval();
  const [mode, setMode] = useState<DetailMode>({ kind: "view" });
  const [rejectReason, setRejectReason] = useState("");

  useEffect(() => {
    setMode({ kind: "view" });
    setRejectReason("");
  }, [approval.id]);

  const submitting = mode.kind === "submitting";

  const handleApprove = useCallback(async () => {
    setMode({ kind: "submitting" });
    try {
      await decide.mutateAsync({ id: approval.id, decision: "approve" });
    } catch {
      setMode({ kind: "view" });
    }
  }, [approval.id, decide]);

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

  const agent = approval.requestedByAgentId
    ? agentById.get(approval.requestedByAgentId)
    : null;
  const agentName = agent?.name ?? "CEO";
  const agentRole = agent?.role ?? null;
  const actionLabel = humanizeApprovalAction(
    approval.actionType,
    approval.payload,
    agentById,
  );
  const op =
    typeof approval.payload.op === "string" ? approval.payload.op : "set_roles";
  const fields = Object.entries(approval.payload).filter(
    ([k]) => !SYSTEM_PAYLOAD_KEYS.has(k),
  );

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
        </div>
      </div>

      {fields.length > 0 && (
        <Card variant="recessed" padding="md">
          <div className="flex flex-col gap-4 text-[12px]">
            {fields.map(([k, v]) => (
              <ReadOnlyField key={k} label={k} value={v} />
            ))}
          </div>
        </Card>
      )}

      <p className="text-[11px] leading-relaxed text-white/45">
        {op === "remove"
          ? "Approving removes this skill from the company library. Agents currently using it keep their copy until reprovisioned."
          : "Approving replaces the skill's allowed-roles whitelist. An empty list means every role may bind it."}
      </p>

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
              onClick={() => {
                setRejectReason("");
                setMode({ kind: "view" });
              }}
              disabled={submitting}
            >
              <X className="size-3" />
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={submitting || rejectReason.trim().length === 0}
              onClick={() => void handleSendReject()}
            >
              {submitting ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          <DismissButton approvalId={approval.id} disabled={submitting} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMode({ kind: "rejecting" })}
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
            {submitting ? "Approving…" : "Approve"}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Tool edit proposal view ──────────────────────────────────────────
// Read-only render of a CEO PROPOSE_TOOL_EDIT row (op + toolId + allowedRoles).
// Approve runs updateById/deleteById via the with-approval engine. Credentials
// and config are never part of the proposal.
function ToolEditDetail({
  approval,
  agentById,
}: {
  approval: ApprovalDTO;
  agentById: Map<string, AgentDTO>;
}) {
  const decide = useDecideApproval();
  const [mode, setMode] = useState<DetailMode>({ kind: "view" });
  const [rejectReason, setRejectReason] = useState("");

  useEffect(() => {
    setMode({ kind: "view" });
    setRejectReason("");
  }, [approval.id]);

  const submitting = mode.kind === "submitting";

  const handleApprove = useCallback(async () => {
    setMode({ kind: "submitting" });
    try {
      await decide.mutateAsync({ id: approval.id, decision: "approve" });
    } catch {
      setMode({ kind: "view" });
    }
  }, [approval.id, decide]);

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

  const agent = approval.requestedByAgentId
    ? agentById.get(approval.requestedByAgentId)
    : null;
  const agentName = agent?.name ?? "CEO";
  const agentRole = agent?.role ?? null;
  const actionLabel = humanizeApprovalAction(
    approval.actionType,
    approval.payload,
    agentById,
  );
  const op =
    typeof approval.payload.op === "string" ? approval.payload.op : "set_roles";
  const fields = Object.entries(approval.payload).filter(
    ([k]) => !SYSTEM_PAYLOAD_KEYS.has(k),
  );

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
        </div>
      </div>

      {fields.length > 0 && (
        <Card variant="recessed" padding="md">
          <div className="flex flex-col gap-4 text-[12px]">
            {fields.map(([k, v]) => (
              <ReadOnlyField key={k} label={k} value={v} />
            ))}
          </div>
        </Card>
      )}

      <p className="text-[11px] leading-relaxed text-white/45">
        {op === "delete"
          ? "Approving deletes this tool. Agents lose access on next reprovision; credentials are destroyed."
          : op === "set_status"
            ? "Approving changes the tool's active/paused state. Paused tools reject invocations but keep their config and credentials."
            : "Approving replaces the tool's allowed-roles whitelist. An empty list means every role may use it. Credentials and config are unchanged."}
      </p>

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
              onClick={() => {
                setRejectReason("");
                setMode({ kind: "view" });
              }}
              disabled={submitting}
            >
              <X className="size-3" />
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={submitting || rejectReason.trim().length === 0}
              onClick={() => void handleSendReject()}
            >
              {submitting ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          <DismissButton approvalId={approval.id} disabled={submitting} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMode({ kind: "rejecting" })}
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
            {submitting ? "Approving…" : "Approve"}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Delete-only proposal view (workflow, task) ───────────────────────
// Minimal read-only render for delete-only with-approval actions: header +
// the payload id + a permanence warning + Approve/Reject/Dismiss. Approve runs
// the company-scoped repo delete via the with-approval engine.
function SimpleDeleteDetail({
  approval,
  agentById,
  noun,
}: {
  approval: ApprovalDTO;
  agentById: Map<string, AgentDTO>;
  noun: string;
}) {
  const decide = useDecideApproval();
  const [mode, setMode] = useState<DetailMode>({ kind: "view" });
  const [rejectReason, setRejectReason] = useState("");

  useEffect(() => {
    setMode({ kind: "view" });
    setRejectReason("");
  }, [approval.id]);

  const submitting = mode.kind === "submitting";

  const handleApprove = useCallback(async () => {
    setMode({ kind: "submitting" });
    try {
      await decide.mutateAsync({ id: approval.id, decision: "approve" });
    } catch {
      setMode({ kind: "view" });
    }
  }, [approval.id, decide]);

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

  const agent = approval.requestedByAgentId
    ? agentById.get(approval.requestedByAgentId)
    : null;
  const agentName = agent?.name ?? "CEO";
  const agentRole = agent?.role ?? null;
  const actionLabel = humanizeApprovalAction(
    approval.actionType,
    approval.payload,
    agentById,
  );
  const fields = Object.entries(approval.payload).filter(
    ([k]) => !SYSTEM_PAYLOAD_KEYS.has(k),
  );

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
        </div>
      </div>

      {fields.length > 0 && (
        <Card variant="recessed" padding="md">
          <div className="flex flex-col gap-4 text-[12px]">
            {fields.map(([k, v]) => (
              <ReadOnlyField key={k} label={k} value={v} />
            ))}
          </div>
        </Card>
      )}

      <p className="text-[11px] leading-relaxed text-white/45">
        Approving permanently deletes this {noun}. This cannot be undone.
      </p>

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
              onClick={() => {
                setRejectReason("");
                setMode({ kind: "view" });
              }}
              disabled={submitting}
            >
              <X className="size-3" />
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={submitting || rejectReason.trim().length === 0}
              onClick={() => void handleSendReject()}
            >
              {submitting ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          <DismissButton approvalId={approval.id} disabled={submitting} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMode({ kind: "rejecting" })}
            disabled={submitting}
          >
            Reject
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => void handleApprove()}
            disabled={submitting}
          >
            <Check className="size-3" />
            {submitting ? "Deleting…" : "Approve delete"}
          </Button>
        </div>
      )}
    </div>
  );
}

// Workflow create / edit proposal. Shows the proposed YAML in a monospace
// block plus any enabled toggle, with approve/reject. Approving runs the
// workflows-service write (create or update) server-side.
function WorkflowProposalDetail({
  approval,
  agentById,
}: {
  approval: ApprovalDTO;
  agentById: Map<string, AgentDTO>;
}) {
  const decide = useDecideApproval();
  const [mode, setMode] = useState<DetailMode>({ kind: "view" });
  const [rejectReason, setRejectReason] = useState("");

  useEffect(() => {
    setMode({ kind: "view" });
    setRejectReason("");
  }, [approval.id]);

  const submitting = mode.kind === "submitting";

  const handleApprove = useCallback(async () => {
    setMode({ kind: "submitting" });
    try {
      await decide.mutateAsync({ id: approval.id, decision: "approve" });
    } catch {
      setMode({ kind: "view" });
    }
  }, [approval.id, decide]);

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

  const agent = approval.requestedByAgentId
    ? agentById.get(approval.requestedByAgentId)
    : null;
  const agentName = agent?.name ?? "CEO";
  const agentRole = agent?.role ?? null;
  const actionLabel = humanizeApprovalAction(
    approval.actionType,
    approval.payload,
    agentById,
  );
  const payload = approval.payload as {
    workflowYamlId?: unknown;
    yamlText?: unknown;
    enabled?: unknown;
  };
  const workflowYamlId =
    typeof payload.workflowYamlId === "string" ? payload.workflowYamlId : null;
  const yamlText = typeof payload.yamlText === "string" ? payload.yamlText : null;
  const enabled =
    typeof payload.enabled === "boolean" ? payload.enabled : null;

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
        </div>
      </div>

      <Card variant="recessed" padding="md">
        <div className="flex flex-col gap-4 text-[12px]">
          {workflowYamlId && (
            <ReadOnlyField label="workflowYamlId" value={workflowYamlId} />
          )}
          {enabled !== null && (
            <ReadOnlyField label="enabled" value={enabled} />
          )}
          {yamlText && (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-white/35">
                yamlText
              </span>
              <pre className="max-h-80 overflow-auto rounded-lg bg-black/30 p-3 text-[11px] leading-relaxed whitespace-pre-wrap text-white/75">
                {yamlText}
              </pre>
            </div>
          )}
        </div>
      </Card>

      <p className="text-[11px] leading-relaxed text-white/45">
        Approving applies this change to the company&apos;s workflows.
      </p>

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
              onClick={() => {
                setRejectReason("");
                setMode({ kind: "view" });
              }}
              disabled={submitting}
            >
              <X className="size-3" />
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={submitting || rejectReason.trim().length === 0}
              onClick={() => void handleSendReject()}
            >
              {submitting ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          <DismissButton approvalId={approval.id} disabled={submitting} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMode({ kind: "rejecting" })}
            disabled={submitting}
          >
            Reject
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleApprove()}
            disabled={submitting}
          >
            <Check className="size-3" />
            {submitting ? "Applying…" : "Approve"}
          </Button>
        </div>
      )}
    </div>
  );
}

function ProposalField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-white/35">
        {label}
      </span>
      <span className="wrap-break-word text-white/75">{value}</span>
    </div>
  );
}

// Clean read-only summary of a deployment proposal. Shared by the pending
// "Deploy this" view and the decided History view so a proposal reads the
// same in both (proper labels, skills comma-joined, not a raw json dump).
function ProposalSummaryCard({ proposal }: { proposal: DeployProposalRequest }) {
  return (
    <Card variant="recessed" padding="md">
      <div className="flex flex-col gap-4 text-[12px]">
        {proposal.suggestedName && (
          <ProposalField label="Suggested name" value={proposal.suggestedName} />
        )}
        <ProposalField label="Role" value={proposal.role || "—"} />
        <ProposalField label="Runtime" value={proposal.runtime || "—"} />
        <ProposalField
          label="Skills"
          value={
            proposal.desiredSkills.length > 0
              ? proposal.desiredSkills.join(", ")
              : "none proposed"
          }
        />
      </div>
    </Card>
  );
}

// ── Decided approval view (History) ──────────────────────────────────
// Read-only render of any decided approval: header + status badge + the
// non-system payload fields + decision metadata. No action buttons.
function DecidedApprovalDetail({
  approval,
  agentById,
}: {
  approval: ApprovalDTO;
  agentById: Map<string, AgentDTO>;
}) {
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
  const isDeploy = approval.actionType === "propose_deployment";
  const readonlyEntries = Object.entries(approval.payload).filter(
    ([k]) => !SYSTEM_PAYLOAD_KEYS.has(k),
  );

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
        </div>
      </div>

      <div className="flex items-center gap-2">
        <DecisionBadge status={approval.status} />
        {approval.decidedAt && (
          <span className="text-[11px] text-white/40">
            decided {relativeTime(approval.decidedAt)}
          </span>
        )}
      </div>

      {approval.rejectionReason && (
        <Card variant="recessed" padding="md">
          <span className="text-[10px] uppercase tracking-wide text-white/35">
            Rejection reason
          </span>
          <p className="mt-1 wrap-break-word text-[12px] text-white/75">
            {approval.rejectionReason}
          </p>
        </Card>
      )}

      {isDeploy ? (
        <ProposalSummaryCard
          proposal={readDeployProposal(approval.id, approval.payload)}
        />
      ) : (
        readonlyEntries.length > 0 && (
          <Card variant="recessed" padding="md">
            <div className="flex flex-col gap-4 text-[12px]">
              {readonlyEntries.map(([k, v]) => (
                <ReadOnlyField key={k} label={k} value={v} />
              ))}
            </div>
          </Card>
        )
      )}
    </div>
  );
}

function DecisionBadge({ status }: { status: string }) {
  const tone =
    status === "approved"
      ? "bg-emerald-500/12 text-emerald-300/90 ring-emerald-500/22"
      : status === "rejected"
        ? "bg-red-500/12 text-red-300/90 ring-red-500/22"
        : "bg-white/8 text-white/50 ring-white/15";
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset",
        tone,
      )}
    >
      {approvalStatusLabel(status)}
    </span>
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
