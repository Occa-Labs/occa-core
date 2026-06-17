// Policy: which approvals may be decided straight from a channel (e.g. a
// Telegram inline button) versus only inside the OS. Pure mapping — no I/O.

import type { ApprovalActionType, ChannelAction } from "@occa/shared/types";

// Action types whose outcome is fully carried by a plain approve/reject
// decision, so a one-tap channel button is safe and complete.
//
// EXCLUDES "propose_deployment" on purpose: approving it does NOT provision
// the agent (there is no `executeOnApprove`) — the operator must open the
// deploy modal in the OS and sign. A channel "Approve" button there would
// flip the row to approved while doing none of the real work, so the
// proposal stays OS-only.
const CHANNEL_DECIDABLE_ACTION_TYPES = new Set<ApprovalActionType>([
  "delegate",
  "edit_company_profile",
  "edit_knowledge",
  "edit_routine",
  "edit_skill_library",
  "edit_tool",
  "delete_workflow",
  "delete_task",
  "create_workflow",
  "edit_workflow",
]);

// Build the interactive approve/reject actions for an approval, or an empty
// array when the action type must be resolved in the OS instead. Callers
// pass the result straight into the notification's `actions` field.
export function channelActionsForApproval(
  approvalId: string,
  actionType: ApprovalActionType,
): ChannelAction[] {
  if (!CHANNEL_DECIDABLE_ACTION_TYPES.has(actionType)) return [];
  return [
    { kind: "approval_decision", decision: "approve", approvalId, label: "✅ Approve" },
    { kind: "approval_decision", decision: "reject", approvalId, label: "❌ Reject" },
  ];
}
